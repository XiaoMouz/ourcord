#!/usr/bin/env bash
# Three-node Phase-1 smoke inside one OrbStack Linux VM, using network
# namespaces as real hosts. This is the repeatable replacement for the manual
# A-B-C smoke notes in docs/ops/smoke-test.md.
#
# It exercises real control + service Workers, real relay, real ourcordd
# instances, real Linux TUN devices, and kernel forwarding. The only shortcut is
# that A/B/C are Linux network namespaces instead of separate OrbStack VMs.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKDIR="${WORKDIR:-$ROOT/.smoke-tmp/abc-netns}"
CONTROL_PORT="${CONTROL_PORT:-8787}"
SERVICE_PORT="${SERVICE_PORT:-8788}"
RELAY_PORT="${RELAY_PORT:-3340}"
STUN_PORT="${STUN_PORT:-3478}"
JWT_SECRET="${JWT_SECRET:-dev-smoke-secret-0123456789}"
SERVICE_INTERNAL_TOKEN="${SERVICE_INTERNAL_TOKEN:-dev-smoke-internal-token}"
ADMIN_TOKEN="${ADMIN_TOKEN:-dev-smoke-admin-token}"
BRIDGE="${BRIDGE:-ocabc-br0}"
BRIDGE_IP="${BRIDGE_IP:-10.222.0.1}"
NET_PREFIX="${NET_PREFIX:-10.222.0}"
ROOM_NAME="${ROOM_NAME:-abc-voice}"
KEEP_SMOKE="${KEEP_SMOKE:-0}"

CONTROL_URL="http://$BRIDGE_IP:$CONTROL_PORT"
CONTROL_LOCAL="http://127.0.0.1:$CONTROL_PORT"
SERVICE_LOCAL="http://127.0.0.1:$SERVICE_PORT"
RELAY_HOST="$BRIDGE_IP"

mkdir -p "$WORKDIR"

PIDS=()
NAMES=(a b c)
USERS=(u1 u2 u3)
IPS=("$NET_PREFIX.11" "$NET_PREFIX.12" "$NET_PREFIX.13")

log() { printf '==> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  set +e
  # Kill each worker's whole process group: `wrangler dev` spawns a workerd
  # child, and killing only the recorded pid leaks workerd (it keeps holding the
  # control/service ports across runs). run_bg uses setsid so $pid == pgid.
  for pid in "${PIDS[@]:-}"; do
    kill -- "-$pid" 2>/dev/null
    kill "$pid" 2>/dev/null
  done
  # Backstop: reap anything still pinned to this run's workdir.
  pkill -9 -f "$WORKDIR" 2>/dev/null
  for name in "${NAMES[@]}"; do
    sudo ip netns del "ocabc-$name" 2>/dev/null || true
  done
  sudo ip link del "$BRIDGE" 2>/dev/null || true
  if [[ "$KEEP_SMOKE" != "1" ]]; then
    rm -rf "$WORKDIR"
  else
    log "Keeping smoke workdir: $WORKDIR"
  fi
}
trap cleanup EXIT INT TERM

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

# The repo's node_modules is shared with the macOS host via the OrbStack mount,
# so a `npm install` run on macOS leaves wrong-platform native binaries (workerd)
# that crash `wrangler dev` here. Fail fast with a fix hint instead of timing out
# on "service did not become ready".
check_node_modules() {
  log "Checking Workers node_modules build for this platform"
  for dir in control service; do
    node22 -e 'require(require("path").resolve("'"$ROOT/$dir"'/node_modules/workerd"))' >/dev/null 2>&1 \
      || fail "$dir/node_modules has a wrong-platform native build (workerd won't load). Fix: (cd $dir && rm -rf node_modules package-lock.json && npm install)"
  done
}

wait_http() {
  local url=$1
  local service_name=$2
  local deadline=$((SECONDS + 45))
  until curl --max-time 2 -fsS "$url" >/dev/null 2>&1; do
    if (( SECONDS > deadline )); then
      fail "$service_name did not become ready at $url"
    fi
    sleep 0.5
  done
}

wait_file_text() {
  local file=$1
  local pattern=$2
  local service_name=$3
  local deadline=$((SECONDS + 45))
  until [[ -f "$file" ]] && grep -qE "$pattern" "$file"; do
    if (( SECONDS > deadline )); then
      [[ -f "$file" ]] && tail -80 "$file" >&2 || true
      fail "$service_name did not log pattern: $pattern"
    fi
    sleep 0.5
  done
}

node22() {
  npx -y node@22.12.0 "$@"
}

jwt() {
  local sub=$1
  python3 - "$JWT_SECRET" "$sub" <<'PY'
import base64, hashlib, hmac, json, sys, time
secret, sub = sys.argv[1], sys.argv[2]
payload = {"sub": sub, "email": f"{sub}@smoke.local", "iat": int(time.time()), "exp": int(time.time()) + 7200}
data = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), data.encode(), hashlib.sha256).digest()).decode().rstrip("=")
print(f"{data}.{sig}")
PY
}

json_file_field() {
  local file=$1
  local expr=$2
  python3 - "$file" "$expr" <<'PY'
import json, sys
path, expr = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    obj = json.load(f)
cur = obj
for part in expr.split("."):
    if part.endswith("]"):
        name, idx = part[:-1].split("[")
        cur = cur[name][int(idx)]
    else:
        cur = cur[part]
print(cur)
PY
}

api_json() {
  local method=$1 url=$2 token=$3 body=${4:-}
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "$url" \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      --data "$body"
  else
    curl -fsS -X "$method" "$url" \
      -H "Authorization: Bearer $token"
  fi
}

run_bg() {
  local name=$1; shift
  log "Starting $name"
  # setsid → new session/process group so cleanup can kill the whole tree
  # (wrangler + its workerd child) via the negative-pid group signal.
  setsid "$@" >"$WORKDIR/$name.log" 2>&1 &
  PIDS+=("$!")
}

setup_netns() {
  log "Setting up netns topology"
  sudo ip link del "$BRIDGE" 2>/dev/null || true
  for name in "${NAMES[@]}"; do
    sudo ip link del "veth-$name" 2>/dev/null || true
  done
  sudo ip link add "$BRIDGE" type bridge
  sudo ip addr add "$BRIDGE_IP/24" dev "$BRIDGE"
  sudo ip link set "$BRIDGE" up

  for i in "${!NAMES[@]}"; do
    local name=${NAMES[$i]} ns="ocabc-${NAMES[$i]}" ip=${IPS[$i]}
    sudo ip netns del "$ns" 2>/dev/null || true
    sudo ip netns add "$ns"
    sudo ip link add "veth-$name" type veth peer name "vpeer-$name"
    sudo ip link set "veth-$name" master "$BRIDGE"
    sudo ip link set "veth-$name" up
    sudo ip link set "vpeer-$name" netns "$ns"
    sudo ip netns exec "$ns" ip link set lo up
    sudo ip netns exec "$ns" ip link set "vpeer-$name" name eth0
    sudo ip netns exec "$ns" ip addr add "$ip/24" dev eth0
    sudo ip netns exec "$ns" ip link set eth0 up
    sudo ip netns exec "$ns" ip route add default via "$BRIDGE_IP"
  done
}

check_netns_underlay() {
  log "Checking netns underlay reachability"
  for name in "${NAMES[@]}"; do
    sudo ip netns exec "ocabc-$name" ping -c 1 -W 2 "$BRIDGE_IP" >/dev/null
  done
}

block_ac_udp() {
  log "Blocking only A<->C UDP direct underlay; control/DERP TCP stays available"
  sudo ip netns exec ocabc-a tc qdisc del dev eth0 clsact 2>/dev/null || true
  sudo ip netns exec ocabc-c tc qdisc del dev eth0 clsact 2>/dev/null || true
  sudo ip netns exec ocabc-a tc qdisc add dev eth0 clsact
  sudo ip netns exec ocabc-c tc qdisc add dev eth0 clsact
  sudo ip netns exec ocabc-a tc filter replace dev eth0 egress protocol ip pref 10 flower dst_ip "${IPS[2]}" ip_proto udp action drop
  sudo ip netns exec ocabc-c tc filter replace dev eth0 egress protocol ip pref 10 flower dst_ip "${IPS[0]}" ip_proto udp action drop
}

build_bins() {
  log "Building daemon, CLI, and relay"
  (cd "$ROOT/daemon" && /usr/local/go/bin/go build -o "$WORKDIR/ourcordd" ./cmd/ourcordd)
  (cd "$ROOT/daemon" && /usr/local/go/bin/go build -o "$WORKDIR/ourcord-cli" ./cmd/ourcord-cli)
  (cd "$ROOT/relay" && /usr/local/go/bin/go build -o "$WORKDIR/ourcord-relay" ./cmd/ourcord-relay)
}

start_workers() {
  log "Preparing local D1 state"
  rm -rf "$WORKDIR/control-persist" "$WORKDIR/service-persist"
  mkdir -p "$WORKDIR/control-persist" "$WORKDIR/service-persist"
  (
    cd "$ROOT/control"
    node22 node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local \
      --persist-to "$WORKDIR/control-persist" >/tmp/ocabc-control-migrate.log 2>&1
  ) || { cat /tmp/ocabc-control-migrate.log >&2; fail "control migrations failed"; }
  (
    cd "$ROOT/control"
    node22 node_modules/wrangler/bin/wrangler.js d1 execute DB --local \
      --persist-to "$WORKDIR/control-persist" \
      --command "INSERT OR IGNORE INTO users (id, email, display_name, created_at) VALUES ('u1','u1@smoke.local','u1',0),('u2','u2@smoke.local','u2',0),('u3','u3@smoke.local','u3',0)" >/tmp/ocabc-control-seed.log 2>&1
  ) || { cat /tmp/ocabc-control-seed.log >&2; fail "control user seed failed"; }

  run_bg service sh -lc "cd '$ROOT/service' && npx -y node@22.12.0 node_modules/wrangler/bin/wrangler.js dev --ip 0.0.0.0 --port '$SERVICE_PORT' --local --persist-to '$WORKDIR/service-persist' --var JWT_SECRET:'$JWT_SECRET' --var SERVICE_INTERNAL_TOKEN:'$SERVICE_INTERNAL_TOKEN' --var ADMIN_TOKEN:'$ADMIN_TOKEN'"
  wait_http "$SERVICE_LOCAL/health" service
  curl -fsS -X POST "$SERVICE_LOCAL/api/admin/init-db" >/dev/null

  run_bg control sh -lc "cd '$ROOT/control' && npx -y node@22.12.0 node_modules/wrangler/bin/wrangler.js dev --ip 0.0.0.0 --port '$CONTROL_PORT' --local --persist-to '$WORKDIR/control-persist' --var JWT_SECRET:'$JWT_SECRET' --var SERVICE_URL:'$SERVICE_LOCAL' --var SERVICE_INTERNAL_TOKEN:'$SERVICE_INTERNAL_TOKEN' --var ADMIN_TOKEN:'$ADMIN_TOKEN' --var ADMIN_USER_IDS:u1"
  wait_http "$CONTROL_LOCAL/health" control
}

start_relay() {
  local token
  token="$(jwt u1)"
  run_bg relay "$WORKDIR/ourcord-relay" \
    --control-url "$CONTROL_LOCAL" \
    --auth-token "$token" \
    --hostname "$RELAY_HOST" \
    --addr ":$RELAY_PORT" \
    --mode lobby \
    --region netns \
    --stun \
    --stun-port "$STUN_PORT" \
    --state-dir "$WORKDIR/relay-state"
  wait_http "http://127.0.0.1:$RELAY_PORT/health" relay
  wait_file_text "$WORKDIR/relay.log" "registered as relay|Resuming as relay" relay
}

create_product_room() {
  log "Creating service lobby, invite, and voice room"
  local t1 t2 t3 lobby invite room
  t1="$(jwt u1)"; t2="$(jwt u2)"; t3="$(jwt u3)"
  api_json POST "$SERVICE_LOCAL/api/lobbies" "$t1" '{"name":"abc-smoke"}' >"$WORKDIR/lobby.json"
  lobby="$(json_file_field "$WORKDIR/lobby.json" id)"
  api_json POST "$SERVICE_LOCAL/api/lobbies/$lobby/invites" "$t1" '{"max_uses":0,"expires_in_seconds":0}' >"$WORKDIR/invite.json"
  invite="$(json_file_field "$WORKDIR/invite.json" code)"
  api_json POST "$SERVICE_LOCAL/api/lobbies/$lobby/join?code=$invite" "$t2" '{}' >/dev/null
  api_json POST "$SERVICE_LOCAL/api/lobbies/$lobby/join?code=$invite" "$t3" '{}' >/dev/null
  api_json POST "$SERVICE_LOCAL/api/lobbies/$lobby/rooms" "$t1" "{\"name\":\"$ROOM_NAME\",\"type\":\"voice\"}" >"$WORKDIR/room.json"
  json_file_field "$WORKDIR/room.json" vpn_namespace >"$WORKDIR/network_id"
  log "network_id=$(cat "$WORKDIR/network_id")"
}

start_daemons() {
  log "Starting three daemons in netns"
  for i in "${!NAMES[@]}"; do
    local name=${NAMES[$i]}
    local user=${USERS[$i]}
    local ns="ocabc-$name"
    local state="$WORKDIR/$name-state"
    local sock="/tmp/ourcord-$name.sock"
    mkdir -p "$state" "$state/config"
    jwt "$user" >"$state/token"
    chmod 600 "$state/token"
    sudo ip netns exec "$ns" env XDG_CONFIG_HOME="$state/config" \
      "$WORKDIR/ourcordd" \
        --control-url "$CONTROL_URL" \
        --socket "$sock" \
        --state-dir "$state" \
        --wg-listen-port 51820 \
        >"$WORKDIR/daemon-$name.log" 2>&1 &
    PIDS+=("$!")
  done
  sleep 1
}

cli() {
  local name=$1; shift
  local state="$WORKDIR/$name-state" sock="/tmp/ourcord-$name.sock" ns="ocabc-$name"
  sudo ip netns exec "$ns" env XDG_CONFIG_HOME="$state/config" "$WORKDIR/ourcord-cli" --socket "$sock" "$@"
}

connect_all() {
  local network_id
  network_id="$(cat "$WORKDIR/network_id")"
  for name in "${NAMES[@]}"; do cli "$name" connect >/dev/null; done
  sleep 2
  for name in "${NAMES[@]}"; do cli "$name" enter-network "$network_id" >/dev/null; done
}

wait_peer_count() {
  local name=$1 deadline=$((SECONDS + 90))
  until cli "$name" peers | python3 -c 'import json,sys; sys.exit(0 if len(json.load(sys.stdin)) >= 2 else 1)' >/dev/null; do
    if (( SECONDS > deadline )); then
      cli "$name" status >&2 || true
      cli "$name" peers >&2 || true
      fail "$name did not see two room peers"
    fi
    sleep 2
  done
}

wait_next_hop() {
  local name=$1 deadline=$((SECONDS + 180))
  until cli "$name" peers | python3 -c 'import json,sys; peers=json.load(sys.stdin); sys.exit(0 if any(p.get("path")=="next-hop" and p.get("next_hop") for p in peers) else 1)' >/dev/null; do
    if (( SECONDS > deadline )); then
      cli "$name" peers >&2 || true
      fail "$name did not receive next-hop route"
    fi
    sleep 5
  done
}

next_hop_peer_ip() {
  local name=$1
  cli "$name" peers | python3 -c 'import json,sys; peers=json.load(sys.stdin); print(next(p["ip4"] for p in peers if p.get("path")=="next-hop"))'
}

main() {
  need curl
  need python3
  need sudo
  need ip
  need tc
  need npx
  need node22
  [[ -c /dev/net/tun ]] || fail "/dev/net/tun is missing"

  check_node_modules
  build_bins
  setup_netns
  check_netns_underlay
  start_workers
  start_relay
  create_product_room
  block_ac_udp
  start_daemons
  connect_all

  log "Waiting for room peer visibility"
  wait_peer_count a
  wait_peer_count b
  wait_peer_count c

  log "Waiting for control to select A-B-C next-hop automatically"
  wait_next_hop a
  wait_next_hop c

  log "Status"
  cli a status
  cli b status
  cli c status
  cli a peers
  cli c peers

  local c_ip
  c_ip="$(next_hop_peer_ip a)"
  log "Pinging A next-hop peer VPN IP from A: $c_ip"
  sudo ip netns exec ocabc-a ping -c 4 -W 3 "$c_ip"

  log "ABC NETNS SMOKE PASSED"
}

main "$@"
