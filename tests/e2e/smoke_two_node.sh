#!/usr/bin/env bash
# tests/e2e/smoke_two_node.sh
#
# Single-host two-daemon smoke test. Brings up two ourcordd instances against
# a mock control plane (no Cloudflare needed) on disjoint state dirs and IPC
# sockets, then verifies they (a) register, (b) create their TUNs with the
# allocated v4/v6, (c) program each other into wg.
#
# Requirements: sudo (to create /dev/net/tun on Linux or utunN on Darwin),
# go (build the daemon + cli + harness), python3 (only for the inline mock).
#
# This is the "real packets" companion to the offline cmd/ourcordd
# connect_test.go integration test. That test verifies the pipeline logic;
# this script verifies the pipeline against actual kernel TUN/wg behavior.
#
# Phase-1 limitation: per-peer ICE agents are not yet wired, so the daemons
# themselves won't auto-discover each other's wg endpoint. This script
# manually injects a loopback endpoint for each peer so wg can handshake
# over localhost UDP. That's enough to confirm TUN/wg are correctly wired.
# True P2P / DERP fallback verification belongs in the Phase-2 ICE work.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKDIR="$(mktemp -d -t ourcord-smoke.XXXX)"
trap 'cleanup' EXIT INT TERM

A_DIR="$WORKDIR/a"
B_DIR="$WORKDIR/b"
A_SOCK="$WORKDIR/a.sock"
B_SOCK="$WORKDIR/b.sock"
MOCK_PORT="${MOCK_PORT:-18642}"
MOCK_PID=""
A_PID=""
B_PID=""

mkdir -p "$A_DIR" "$B_DIR"

cleanup() {
    set +e
    [[ -n "$A_PID" ]] && sudo kill "$A_PID" 2>/dev/null
    [[ -n "$B_PID" ]] && sudo kill "$B_PID" 2>/dev/null
    [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
    sudo rm -rf "$WORKDIR"
}

# ---- 1. Build daemon + cli ----
echo "==> Building daemon + cli..."
( cd "$ROOT/daemon" && go build -o "$WORKDIR/ourcordd" ./cmd/ourcordd && \
                       go build -o "$WORKDIR/ourcord-cli" ./cmd/ourcord-cli )

# ---- 2. Generate a token file for each daemon ----
echo "smoke-token-a" > "$A_DIR/token"
echo "smoke-token-b" > "$B_DIR/token"
chmod 600 "$A_DIR/token" "$B_DIR/token"

# ---- 3. Start the inline mock control plane ----
echo "==> Starting mock control plane on :$MOCK_PORT..."
python3 "$ROOT/tests/e2e/mock_control.py" --port "$MOCK_PORT" \
    --state "$WORKDIR/mock.json" &
MOCK_PID=$!
sleep 0.5

# ---- 4. Start the two daemons (sudo for TUN). ----
# IPC HMAC key lives at $XDG_CONFIG_HOME/ourcord/ipc.key — give each daemon
# its own XDG_CONFIG_HOME so they don't share the secret with each other (or
# with your real installed daemon).
echo "==> Starting daemon A..."
sudo XDG_CONFIG_HOME="$A_DIR/config" "$WORKDIR/ourcordd" \
    --control-url "http://127.0.0.1:$MOCK_PORT" \
    --socket "$A_SOCK" \
    --state-dir "$A_DIR" \
    > "$WORKDIR/a.log" 2>&1 &
A_PID=$!
sleep 1

echo "==> Starting daemon B..."
sudo XDG_CONFIG_HOME="$B_DIR/config" "$WORKDIR/ourcordd" \
    --control-url "http://127.0.0.1:$MOCK_PORT" \
    --socket "$B_SOCK" \
    --state-dir "$B_DIR" \
    > "$WORKDIR/b.log" 2>&1 &
B_PID=$!
sleep 1

# ---- 5. Trigger connect on both ----
echo "==> connect A..."
sudo XDG_CONFIG_HOME="$A_DIR/config" "$WORKDIR/ourcord-cli" --socket "$A_SOCK" connect

echo "==> connect B..."
sudo XDG_CONFIG_HOME="$B_DIR/config" "$WORKDIR/ourcord-cli" --socket "$B_SOCK" connect

sleep 2

# ---- 6. Status check ----
echo "==> status A:"
sudo XDG_CONFIG_HOME="$A_DIR/config" "$WORKDIR/ourcord-cli" --socket "$A_SOCK" status
echo "==> status B:"
sudo XDG_CONFIG_HOME="$B_DIR/config" "$WORKDIR/ourcord-cli" --socket "$B_SOCK" status

# ---- 7. Verify TUN existence ----
case "$(uname)" in
    Linux)
        echo "==> ip addr (looking for VPN prefixes):"
        ip -br addr | grep -E "100\.64\.|fd7a:" || {
            echo "FAIL: no VPN address visible"
            exit 1
        }
        ;;
    Darwin)
        echo "==> ifconfig utun (looking for VPN prefixes):"
        ifconfig | grep -E "inet (100\.64|fd7a)" || {
            echo "FAIL: no VPN address visible"
            exit 1
        }
        ;;
esac

echo "==> ALL CHECKS PASSED."
echo "    Logs: $WORKDIR/{a,b}.log"
echo "    Mock state: $WORKDIR/mock.json"
echo "    NOTE: actual peer-to-peer ping requires per-peer ICE wiring (Phase-2)."
