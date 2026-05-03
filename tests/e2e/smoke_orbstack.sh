#!/usr/bin/env bash
# tests/e2e/smoke_orbstack.sh
#
# Real two-node WireGuard handshake over OrbStack bridged network.
# Two real Linux kernels, two real TUNs, real wg userspace exchanging Noise
# handshakes over real UDP — the highest-fidelity smoke we can do without
# leaving the developer machine.
#
# Pipeline this script exercises end-to-end:
#   register → IP allocation → TUN addr → wg listen_port pinning →
#   endpoint hint round-trip via /api/peers/config → wg handshake →
#   ICMP over the tunnel.
#
# Phase-1 limitation worked around with --wg-endpoint: per-peer ICE
# candidate exchange is not yet wired, so endpoints cannot be discovered
# automatically. Once Phase-2 ICE lands, --wg-endpoint becomes optional.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# WORKDIR must live under /Users so OrbStack VMs can read it via the
# auto-mounted /Users path (/var/folders is NOT mounted into the VM).
WORKDIR="$(mktemp -d "$HOME/.cache/ourcord-orb.XXXX" 2>/dev/null || mktemp -d "$ROOT/.smoke-tmp.XXXX")"
mkdir -p "$HOME/.cache" 2>/dev/null || true
MOCK_PORT="${MOCK_PORT:-18642}"
WG_PORT="${WG_PORT:-51820}"
ARCH="${ARCH:-arm64}"
VM_A="ourcord-a"
VM_B="ourcord-b"
MOCK_PID=""

cleanup() {
    set +e
    [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
    if [[ "${KEEP_VMS:-0}" != "1" ]]; then
        echo "==> Removing OrbStack VMs (set KEEP_VMS=1 to keep them)..."
        orb delete -f "$VM_A" >/dev/null 2>&1
        orb delete -f "$VM_B" >/dev/null 2>&1
    fi
    rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

# Strip OrbStack's update-banner box-drawing noise from command output.
clean() { grep -avE '^\s*(╭|╰|│|Updates include|Run "orb update"|OrbStack update available)' || true; }

vm_run() {
    local vm=$1; shift
    orb run -m "$vm" "$@" 2>&1 | clean
}

# ---- 1. Build daemon for linux/$ARCH ----
echo "==> Building daemon (linux/$ARCH)..."
( cd "$ROOT/daemon"
  GOOS=linux GOARCH="$ARCH" CGO_ENABLED=0 go build -o "$WORKDIR/ourcordd" ./cmd/ourcordd
  GOOS=linux GOARCH="$ARCH" CGO_ENABLED=0 go build -o "$WORKDIR/ourcord-cli" ./cmd/ourcord-cli
)

# ---- 2. Create the two VMs (idempotent) ----
ensure_vm() {
    local name=$1
    if orb list 2>&1 | clean | awk '{print $1}' | grep -qx "$name"; then
        echo "==> VM $name already exists; reusing."
    else
        echo "==> Creating VM $name (this may take ~30s)..."
        orb create -a "$ARCH" ubuntu:noble "$name" >/dev/null 2>&1 || {
            echo "FAIL: orb create $name"; exit 1; }
    fi
    # iputils-ping for ICMP, iproute2 for `ip` (usually preinstalled).
    vm_run "$name" sudo apt-get update -qq >/dev/null
    vm_run "$name" sudo DEBIAN_FRONTEND=noninteractive apt-get install -yqq iputils-ping iproute2 >/dev/null
}
ensure_vm "$VM_A"
ensure_vm "$VM_B"

vm_ip() {
    vm_run "$1" ip -4 -o addr show dev eth0 | awk '{print $4}' | cut -d/ -f1 | head -1
}
IP_A="$(vm_ip $VM_A)"
IP_B="$(vm_ip $VM_B)"
[[ -z "$IP_A" || -z "$IP_B" ]] && { echo "FAIL: could not discover VM IPs (A=$IP_A B=$IP_B)"; exit 1; }
echo "    vm-a: $IP_A    vm-b: $IP_B"

# Sanity: A and B must be able to reach each other on $WG_PORT/UDP. They are
# on the same OrbStack bridge so this should always be true.
echo "==> Sanity ping vm-a ↔ vm-b underlay..."
vm_run "$VM_A" ping -c 1 -W 2 "$IP_B" | tail -2 | head -1

# ---- 3. Mock control plane on host, reachable from VMs as host.orb.internal ----
echo "==> Starting mock control plane on :$MOCK_PORT..."
python3 "$ROOT/tests/e2e/mock_control.py" \
    --bind 0.0.0.0 --port "$MOCK_PORT" --state "$WORKDIR/mock.json" >"$WORKDIR/mock.log" 2>&1 &
MOCK_PID=$!
sleep 0.5
HOST_HOSTNAME="host.orb.internal"

# ---- 4. Push binary + token into each VM and start daemon ----
USER_LINUX="$(vm_run $VM_A whoami | tail -1)"
[[ -z "$USER_LINUX" ]] && USER_LINUX="$USER"

start_daemon() {
    local vm=$1 ip=$2 token=$3
    echo "==> Setting up daemon in $vm ($ip)..."
    vm_run "$vm" mkdir -p "/home/$USER_LINUX/ourcord-state" "/home/$USER_LINUX/.config/ourcord"
    # OrbStack auto-mounts /Users/$USER, copy from there.
    vm_run "$vm" cp "$WORKDIR/ourcordd" "/home/$USER_LINUX/ourcordd"
    vm_run "$vm" cp "$WORKDIR/ourcord-cli" "/home/$USER_LINUX/ourcord-cli"
    vm_run "$vm" chmod +x "/home/$USER_LINUX/ourcordd" "/home/$USER_LINUX/ourcord-cli"
    vm_run "$vm" sh -c "echo '$token' > '/home/$USER_LINUX/ourcord-state/token' && chmod 600 '/home/$USER_LINUX/ourcord-state/token'"
    vm_run "$vm" sudo sh -c "pkill -x ourcordd || true; sleep 0.2"

    echo "==> Starting daemon in $vm..."
    vm_run "$vm" sudo sh -c "
        XDG_CONFIG_HOME=/home/$USER_LINUX/.config \
        nohup '/home/$USER_LINUX/ourcordd' \
            --control-url 'http://$HOST_HOSTNAME:$MOCK_PORT' \
            --socket /tmp/ourcord.sock \
            --state-dir '/home/$USER_LINUX/ourcord-state' \
            --wg-listen-port $WG_PORT \
            --wg-endpoint '$ip:$WG_PORT' \
            > /tmp/ourcordd.log 2>&1 &
        sleep 0.6
        chmod 666 /tmp/ourcord.sock || true
    "
}
start_daemon "$VM_A" "$IP_A" "smoke-token-a"
start_daemon "$VM_B" "$IP_B" "smoke-token-b"
sleep 1

# ---- 5. Trigger connect on each, twice. The second connect lets each side
#         see the other's endpoint hint that landed during the first round.
cli() {
    local vm=$1 cmd=$2
    vm_run "$vm" sudo sh -c "XDG_CONFIG_HOME=/home/$USER_LINUX/.config '/home/$USER_LINUX/ourcord-cli' --socket /tmp/ourcord.sock $cmd"
}
echo "==> First connect (registers and pins listen port)..."
cli "$VM_A" connect
cli "$VM_B" connect
sleep 1
echo "==> Reconnect to refresh peer mesh with both endpoints..."
cli "$VM_A" disconnect; cli "$VM_B" disconnect; sleep 0.5
cli "$VM_A" connect
cli "$VM_B" connect
sleep 2

# ---- 6. Assertions ----
VPN_ADDRS="$(python3 -c "
import json
d = json.load(open('$WORKDIR/mock.json'))
by_endpoint = {p.get('endpoint', ''): p for p in d['peers'].values()}
for endpoint in ('$IP_A:$WG_PORT', '$IP_B:$WG_PORT'):
    p = by_endpoint.get(endpoint)
    if not p:
        raise SystemExit(f'missing peer for endpoint {endpoint}')
    print(p['ip4'], p['ip6'])
" 2>/dev/null)"
[[ -z "$VPN_ADDRS" ]] && { echo "FAIL: could not discover allocated VPN addrs"; cat "$WORKDIR/mock.json"; exit 1; }
A_VPN4="$(echo "$VPN_ADDRS" | sed -n '1s/ .*//p')"
A_VPN6="$(echo "$VPN_ADDRS" | sed -n '1s/.* //p')"
B_VPN4="$(echo "$VPN_ADDRS" | sed -n '2s/ .*//p')"
B_VPN6="$(echo "$VPN_ADDRS" | sed -n '2s/.* //p')"

echo "==> ip addr on $VM_A:"
ADDR_A="$(vm_run "$VM_A" ip -br addr)"
echo "$ADDR_A" | grep -F "$A_VPN4" >/dev/null || { echo "$ADDR_A"; echo "FAIL: VPN v4 addr missing on A ($A_VPN4)"; exit 1; }
echo "$ADDR_A" | grep -F "$A_VPN6" >/dev/null || { echo "$ADDR_A"; echo "FAIL: VPN v6 addr missing on A ($A_VPN6)"; exit 1; }
echo "$ADDR_A" | grep -F "$A_VPN4"
echo "==> ip addr on $VM_B:"
ADDR_B="$(vm_run "$VM_B" ip -br addr)"
echo "$ADDR_B" | grep -F "$B_VPN4" >/dev/null || { echo "$ADDR_B"; echo "FAIL: VPN v4 addr missing on B ($B_VPN4)"; exit 1; }
echo "$ADDR_B" | grep -F "$B_VPN6" >/dev/null || { echo "$ADDR_B"; echo "FAIL: VPN v6 addr missing on B ($B_VPN6)"; exit 1; }
echo "$ADDR_B" | grep -F "$B_VPN4"

# Discover allocated IPs from mock state file (authoritative source).
B_VPN_IP="$B_VPN4"

echo "==> ping $B_VPN_IP from $VM_A (over the VPN tunnel):"
if vm_run "$VM_A" ping -c 3 -W 3 "$B_VPN_IP" | tee /dev/stderr | grep -q "0% packet loss\|1 received\|2 received\|3 received"; then
    echo
    echo "==> ✅ END-TO-END VPN PING SUCCEEDED."
    echo "    Two real Linux kernels, two TUNs, real wg handshake over $WG_PORT/UDP."
else
    echo
    echo "==> ❌ ping failed. Dumping daemon logs:"
    echo "--- $VM_A ourcordd.log (tail) ---"
    vm_run "$VM_A" sudo tail -50 /tmp/ourcordd.log
    echo "--- $VM_B ourcordd.log (tail) ---"
    vm_run "$VM_B" sudo tail -50 /tmp/ourcordd.log
    echo "--- mock control state ---"
    cat "$WORKDIR/mock.json"
    exit 1
fi
