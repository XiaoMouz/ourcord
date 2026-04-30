#!/usr/bin/env python3
"""
Minimal mock OurCord control plane for tests/e2e/smoke_two_node.sh.

Implements just the two endpoints daemon connect() touches:
  POST /api/peers/register   -> allocates a /32 + /128 from a small pool
  GET  /api/peers/config     -> returns *other* registered peers

Persists state to a JSON file so multiple daemon registrations during the
same smoke run see each other.

Why python (not wrangler dev)?  Avoids needing a configured D1/KV binding,
working OAuth provider, or schema migrations on the developer's machine.
The real Cloudflare Worker is exercised by the control/ vitest suite (W6)
and by deployed-environment smoke tests, not here.
"""

import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
STATE_PATH = None
V4_POOL = [f"198.18.0.{i}" for i in range(10, 100)]
V6_POOL = [f"fdab:cdef:123::{i:x}" for i in range(10, 100)]


def load():
    if not STATE_PATH or not os.path.exists(STATE_PATH):
        return {"peers": {}, "next": 0}
    with open(STATE_PATH) as f:
        return json.load(f)


def save(state):
    if STATE_PATH:
        with open(STATE_PATH, "w") as f:
            json.dump(state, f, indent=2)


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path != "/api/peers/register":
            return self._json(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(n))
        with LOCK:
            state = load()
            pub = body["public_key"]
            if pub in state["peers"]:
                peer = state["peers"][pub]
                # Refresh endpoint hint on every register; daemons may rebind.
                if body.get("wg_endpoint"):
                    peer["endpoint"] = body["wg_endpoint"]
            else:
                idx = state["next"]
                state["next"] += 1
                peer = {
                    "id": f"peer-{idx}",
                    "user_id": f"u-{idx}",
                    "public_key": pub,
                    "name": body.get("name", ""),
                    "platform": body.get("platform", ""),
                    "ip4": V4_POOL[idx],
                    "ip6": V6_POOL[idx],
                    "endpoint": body.get("wg_endpoint", ""),
                }
                state["peers"][pub] = peer
            save(state)
        # Strip non-API fields before returning.
        public_peer = {k: v for k, v in peer.items() if k != "endpoint"}
        self._json(200, {"peer": public_peer, "config": ""})

    def do_GET(self):
        if not self.path.startswith("/api/peers/config"):
            return self._json(404, {"error": "not found"})
        self_pub = self.headers.get("X-Peer-Public-Key", "")
        with LOCK:
            state = load()
            others = [
                {
                    "id": p["id"],
                    "public_key": p["public_key"],
                    "ip4": p["ip4"],
                    "ip6": p["ip6"],
                    "name": p["name"],
                    "endpoint": p.get("endpoint", ""),
                }
                for k, p in state["peers"].items()
                if k != self_pub
            ]
        self._json(200, {"peers": others, "relays": []})

    def log_message(self, fmt, *args):
        # Silence default access log; comment out to debug.
        pass


def main():
    global STATE_PATH
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18642)
    ap.add_argument("--state", required=True)
    ap.add_argument("--bind", default="127.0.0.1",
                    help="Bind address (use 0.0.0.0 to expose to OrbStack VMs)")
    args = ap.parse_args()
    STATE_PATH = args.state
    if os.path.exists(STATE_PATH):
        os.remove(STATE_PATH)
    save({"peers": {}, "next": 0})
    srv = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"mock-control listening on http://{args.bind}:{args.port}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
