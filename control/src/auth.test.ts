import { describe, it, expect } from "vitest";
import { signToken, verifyToken, makeToken, generateOTP, generateId } from "./auth";

const SECRET = "test-secret-do-not-reuse";

describe("signToken / verifyToken", () => {
  it("round-trips a valid payload", async () => {
    const payload = makeToken("user-1", "alice@example.com");
    const tok = await signToken(payload, SECRET);
    const back = await verifyToken(tok, SECRET);
    expect(back).not.toBeNull();
    expect(back!.sub).toBe("user-1");
    expect(back!.email).toBe("alice@example.com");
  });

  it("returns null for wrong secret", async () => {
    const tok = await signToken(makeToken("u", "e@e"), SECRET);
    expect(await verifyToken(tok, "wrong-secret")).toBeNull();
  });

  it("returns null for tampered payload", async () => {
    const tok = await signToken(makeToken("u", "e@e"), SECRET);
    const [data, sig] = tok.split(".");
    // Flip a character in the payload but keep the signature.
    const tampered = data.slice(0, -1) + (data.endsWith("a") ? "b" : "a") + "." + sig;
    expect(await verifyToken(tampered, SECRET)).toBeNull();
  });

  it("returns null for malformed token", async () => {
    expect(await verifyToken("not-a-token", SECRET)).toBeNull();
    expect(await verifyToken("only.one.dot.too.many", SECRET)).toBeNull();
  });

  it("returns null for expired payload", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const tok = await signToken(
      { sub: "u", email: "e@e", iat: past - 100, exp: past },
      SECRET,
    );
    expect(await verifyToken(tok, SECRET)).toBeNull();
  });

  it("makeToken sets exp ~30 days in the future", () => {
    const t = makeToken("x", "y@z");
    const expectedExp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    expect(Math.abs(t.exp - expectedExp)).toBeLessThan(5);
  });
});

describe("generateOTP", () => {
  it("returns a 6-character zero-padded numeric string", () => {
    for (let i = 0; i < 50; i++) {
      const otp = generateOTP();
      expect(otp).toMatch(/^\d{6}$/);
    }
  });

  it("is not deterministic", () => {
    const otps = new Set(Array.from({ length: 20 }, () => generateOTP()));
    expect(otps.size).toBeGreaterThan(1);
  });
});

describe("generateId", () => {
  it("returns a 32-char lowercase hex string", () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is unique across many invocations", () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateId()));
    expect(ids.size).toBe(200);
  });
});
