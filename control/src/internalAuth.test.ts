import { describe, it, expect } from "vitest";
import { signInternalHeaders, internalSigPayload, INTERNAL_SIG_WINDOW_SEC } from "./internalAuth";

async function hmacB64url(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

describe("internal request signing (G6)", () => {
  const URL_UNDER_TEST = "https://service.example/api/internal/rooms/lobby-a-b-voice/member-ids";

  it("emits fresh, well-formed signed headers", async () => {
    const before = Math.floor(Date.now() / 1000);
    const headers = await signInternalHeaders("s2s-secret", "GET", URL_UNDER_TEST);
    const after = Math.floor(Date.now() / 1000);

    const ts = parseInt(headers["X-Internal-Ts"], 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(headers["X-Internal-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["X-Internal-Sig"]).toMatch(/^[A-Za-z0-9_-]+$/);

    // The signature must recompute from the documented payload contract.
    const expected = await hmacB64url(
      "s2s-secret",
      internalSigPayload(headers["X-Internal-Ts"], headers["X-Internal-Nonce"], "GET", URL_UNDER_TEST),
    );
    expect(headers["X-Internal-Sig"]).toBe(expected);
  });

  it("binds method and path+query, not the host", () => {
    const p = internalSigPayload("100", "abc", "get", "https://a.example/api/internal/rooms/r1/member-ids?x=1");
    expect(p).toBe("100\nabc\nGET\n/api/internal/rooms/r1/member-ids?x=1");
    // Same path on a different host signs identically (host is transport, path is authz scope).
    const q = internalSigPayload("100", "abc", "GET", "https://b.example/api/internal/rooms/r1/member-ids?x=1");
    expect(q).toBe(p);
  });

  it("keeps the freshness window in sync with the service-side contract", () => {
    expect(INTERNAL_SIG_WINDOW_SEC).toBe(90);
  });

  it("generates unique nonces per call", async () => {
    const a = await signInternalHeaders("s", "GET", URL_UNDER_TEST);
    const b = await signInternalHeaders("s", "GET", URL_UNDER_TEST);
    expect(a["X-Internal-Nonce"]).not.toBe(b["X-Internal-Nonce"]);
  });
});
