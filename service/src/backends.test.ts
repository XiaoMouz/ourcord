import { describe, it, expect, vi } from "vitest";
import { registerBackend, shareBackend, deactivateBackend, checkBackendHealth, validBackendURL, joinBackendURL, backendHealthURL, signBackendCapability, backendFileURL, listBackends } from "./backends";
import { getDownloadUrl } from "./files";
import type { Env } from "./types";

const SECRET = "test-secret-1234567890abcdef";

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const b = new Uint8Array(sig);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeToken(sub = "u1"): Promise<string> {
  const data = b64url(JSON.stringify({ sub, email: `${sub}@x.io`, iat: 1, exp: 9999999999 }));
  return `${data}.${await hmacSign(SECRET, data)}`;
}

type DBStep = { first?: unknown; run?: unknown; all?: unknown };

function makeDB(plan: DBStep[]): D1Database {
  let i = 0;
  return {
    prepare: vi.fn(() => {
      const idx = i++;
      const step = () => plan[idx] || {};
      const s: any = {
        bind: vi.fn(() => s),
        first: vi.fn(async () => step().first ?? null),
        run: vi.fn(async () => step().run ?? { meta: { changes: 1 } }),
        all: vi.fn(async () => step().all ?? { results: [] }),
      };
      return s as D1PreparedStatement;
    }),
    batch: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

function envOf(db: D1Database): Env {
  return {
    ENVIRONMENT: "production",
    JWT_SECRET: SECRET,
    DB: db,
    FILES: {} as R2Bucket,
    KV: {} as KVNamespace,
  } as Env;
}

function postJSON(url: string, body: unknown, token: string): Request {
  const s = JSON.stringify(body);
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-length": String(s.length),
    },
    body: s,
  });
}

describe("validBackendURL / joinBackendURL", () => {
  it("accepts plain http(s) URLs and rejects everything else", () => {
    expect(validBackendURL("https://files.me.example")).toBe(true);
    expect(validBackendURL("http://10.0.0.5:8080/base")).toBe(true);
    expect(validBackendURL("ftp://files.me.example")).toBe(false);
    expect(validBackendURL("https://user:pw@files.me.example")).toBe(false);
    expect(validBackendURL("https://files.me.example/?x=1")).toBe(false);
    expect(validBackendURL("not a url")).toBe(false);
    expect(validBackendURL("https://" + "a".repeat(300))).toBe(false);
  });

  it("joins without duplicate slashes", () => {
    expect(joinBackendURL("https://x.example/", "files/F1/a.txt")).toBe("https://x.example/files/F1/a.txt");
    expect(joinBackendURL("https://x.example/base", "files/F1/a.txt")).toBe("https://x.example/base/files/F1/a.txt");
    expect(backendHealthURL("https://x.example/base/")).toBe("https://x.example/base/.well-known/ourcord-file-backend/health");
  });
});

describe("registerBackend", () => {
  it("registers a personal backend for the caller", async () => {
    const token = await makeToken();
    const db = makeDB([{ run: { meta: { changes: 1 } } }]);
    const resp = await registerBackend(
      postJSON("https://service.example/api/backends", { base_url: "https://files.me.example/", name: "mine" }, token),
      envOf(db),
    );
    expect(resp.status).toBe(201);
    const body = await resp.json<{ owner_id: string; lobby_id: string | null; base_url: string }>();
    expect(body.owner_id).toBe("u1");
    expect(body.lobby_id).toBeNull();
    // Trailing slash normalized away so joinBackendURL stays canonical.
    expect(body.base_url).toBe("https://files.me.example");
  });

  it("rejects a lobby backend from a plain member", async () => {
    const token = await makeToken();
    const db = makeDB([{ first: { role: "member" } }]);
    const resp = await registerBackend(
      postJSON("https://service.example/api/backends", { base_url: "https://x.example", lobby_id: "L1" }, token),
      envOf(db),
    );
    expect(resp.status).toBe(403);
  });

  it("allows a lobby backend from an admin", async () => {
    const token = await makeToken();
    const db = makeDB([{ first: { role: "admin" } }, { run: { meta: { changes: 1 } } }]);
    const resp = await registerBackend(
      postJSON("https://service.example/api/backends", { base_url: "https://x.example", lobby_id: "L1" }, token),
      envOf(db),
    );
    expect(resp.status).toBe(201);
    const body = await resp.json<{ lobby_id: string | null }>();
    expect(body.lobby_id).toBe("L1");
  });

  it("rejects an invalid base_url", async () => {
    const token = await makeToken();
    const resp = await registerBackend(
      postJSON("https://service.example/api/backends", { base_url: "javascript:alert(1)" }, token),
      envOf(makeDB([])),
    );
    expect(resp.status).toBe(400);
  });
});

describe("shareBackend", () => {
  it("owner shares a personal backend", async () => {
    const token = await makeToken();
    const db = makeDB([
      { first: { owner_id: "u1", lobby_id: null, active: 1 } },
      { run: { meta: { changes: 1 } } },
    ]);
    const resp = await shareBackend(
      postJSON("https://service.example/api/backends/B1/shares", { user_id: "u2" }, token),
      envOf(db),
      "B1",
    );
    expect(resp.status).toBe(201);
  });

  it("non-owner cannot share", async () => {
    const token = await makeToken("u9");
    const db = makeDB([{ first: { owner_id: "u1", lobby_id: null, active: 1 } }]);
    const resp = await shareBackend(
      postJSON("https://service.example/api/backends/B1/shares", { user_id: "u2" }, token),
      envOf(db),
      "B1",
    );
    expect(resp.status).toBe(403);
  });

  it("lobby backends cannot be individually shared", async () => {
    const token = await makeToken();
    const db = makeDB([{ first: { owner_id: "u1", lobby_id: "L1", active: 1 } }]);
    const resp = await shareBackend(
      postJSON("https://service.example/api/backends/B1/shares", { user_id: "u2" }, token),
      envOf(db),
      "B1",
    );
    expect(resp.status).toBe(400);
  });
});

describe("deactivateBackend", () => {
  it("owner deactivates; non-owner sees 404", async () => {
    const token = await makeToken();
    const ok = await deactivateBackend(
      new Request("https://service.example/api/backends/B1", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
      envOf(makeDB([{ run: { meta: { changes: 1 } } }])),
      "B1",
    );
    expect(ok.status).toBe(200);

    const notOwner = await deactivateBackend(
      new Request("https://service.example/api/backends/B1", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
      envOf(makeDB([{ run: { meta: { changes: 0 } } }])),
      "B1",
    );
    expect(notOwner.status).toBe(404);
  });
});

describe("checkBackendHealth", () => {
  function checkReq(token: string): Request {
    return new Request("https://service.example/api/backends/B1/check", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("owner probes a personal backend and stores healthy", async () => {
    const token = await makeToken();
    const db = makeDB([
      { first: { id: "B1", owner_id: "u1", lobby_id: null, base_url: "https://files.me.example", active: 1 } },
      { run: { meta: { changes: 1 } } },
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    try {
      const resp = await checkBackendHealth(checkReq(token), envOf(db), "B1");
      expect(resp.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://files.me.example/.well-known/ourcord-file-backend/health",
        { method: "GET" },
      );
      const body = await resp.json<{ backend_id: string; health_status: string; error: string | null }>();
      expect(body.backend_id).toBe("B1");
      expect(body.health_status).toBe("healthy");
      expect(body.error).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects non-owner checks on personal backends", async () => {
    const token = await makeToken("u9");
    const db = makeDB([
      { first: { id: "B1", owner_id: "u1", lobby_id: null, base_url: "https://files.me.example", active: 1 } },
    ]);
    const resp = await checkBackendHealth(checkReq(token), envOf(db), "B1");
    expect(resp.status).toBe(403);
  });
});

describe("getDownloadUrl for backend-hosted files", () => {
  const FILE_ROW = {
    id: "F1",
    room_id: "R1",
    uploader_id: "u1",
    filename: "doc.bin",
    size_bytes: 10,
    mime_type: "application/octet-stream",
    storage_location: "user_server" as const,
    storage_key: "files/F1/doc.bin",
    backend_id: "B1",
    expires_at: null,
    created_at: 1,
    upload_status: "uploaded" as const,
  };

  function dlReq(token: string): Request {
    return new Request("https://service.example/api/rooms/R1/files/F1/download", {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("resolves the backend URL for a live backend", async () => {
    const token = await makeToken();
    const db = makeDB([
      { first: FILE_ROW },
      { first: { lobby_id: "L1" } },
      { first: { 1: 1 } }, // membership
      { first: { id: "B1", base_url: "https://files.me.example", active: 1 } },
    ]);
    const resp = await getDownloadUrl(dlReq(token), envOf(db), "R1", "F1");
    expect(resp.status).toBe(200);
    const body = await resp.json<{ url: string; backend_id: string }>();
    expect(body.url).toBe("https://files.me.example/files/F1/doc.bin");
    expect(body.backend_id).toBe("B1");
  });

  it("returns 503 when the backend is deactivated or gone", async () => {
    const token = await makeToken();
    const db = makeDB([
      { first: FILE_ROW },
      { first: { lobby_id: "L1" } },
      { first: { 1: 1 } },
      { first: null }, // backend row inactive/missing
    ]);
    const resp = await getDownloadUrl(dlReq(token), envOf(db), "R1", "F1");
    expect(resp.status).toBe(503);
  });
});

describe("backend capabilities (cap tokens)", () => {
  const SECRET_BK = {
    base_url: "https://files.me.example",
    upload_secret: "cap-secret-0123456789abcdef",
  };

  it("signs an exp.sig capability bound to path+op and appends it to the URL", async () => {
    const url = await backendFileURL(SECRET_BK, "files/F1/doc.bin", "put", 3600);
    const m = url.match(/^https:\/\/files\.me\.example\/files\/F1\/doc\.bin\?cap=(\d+)\.([A-Za-z0-9_-]+)$/);
    expect(m).not.toBeNull();
    const exp = parseInt(m![1], 10);
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // The cap must recompute from the documented contract.
    const recomputed = await signBackendCapabilityAt(SECRET_BK.upload_secret, "files/F1/doc.bin", "put", exp);
    expect(`${m![1]}.${m![2]}`).toBe(recomputed);
    // Op-bound: a get cap over the same path differs.
    const getCap = await signBackendCapabilityAt(SECRET_BK.upload_secret, "files/F1/doc.bin", "get", exp);
    expect(getCap).not.toBe(recomputed);
  });

  it("percent-encodes path segments but signs the raw storage key", async () => {
    const key = "files/F1/na me #1.bin";
    const url = await backendFileURL(SECRET_BK, key, "get", 60);
    expect(url).toContain("/files/F1/na%20me%20%231.bin?cap=");
  });

  it("open backend (no secret) gets a bare URL", async () => {
    const url = await backendFileURL({ base_url: "https://x.example", upload_secret: "" }, "files/F1/a.bin", "put", 60);
    expect(url).toBe("https://x.example/files/F1/a.bin");
    expect(await signBackendCapability("", "files/F1/a.bin", "put", 60)).toBe("");
  });

  it("registerBackend stores the secret but never returns it; short secrets are rejected", async () => {
    const token = await makeToken();
    const binds: unknown[][] = [];
    const db = {
      prepare: vi.fn(() => {
        const s: any = {
          bind: vi.fn((...args: unknown[]) => { binds.push(args); return s; }),
          first: vi.fn(async () => null),
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
          all: vi.fn(async () => ({ results: [] })),
        };
        return s;
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database;

    const resp = await registerBackend(
      postJSON("https://service.example/api/backends", {
        base_url: "https://files.me.example",
        upload_secret: "cap-secret-0123456789abcdef",
      }, token),
      envOf(db),
    );
    expect(resp.status).toBe(201);
    const bodyText = JSON.stringify(await resp.json());
    expect(bodyText).not.toContain("cap-secret-0123456789abcdef");
    expect(bodyText).not.toContain("upload_secret");
    // …but the INSERT carries it.
    expect(binds[0]).toContain("cap-secret-0123456789abcdef");

    const tooShort = await registerBackend(
      postJSON("https://service.example/api/backends", { base_url: "https://x.example", upload_secret: "short" }, token),
      envOf(makeDB([])),
    );
    expect(tooShort.status).toBe(400);
  });
});

describe("listBackends never exposes upload_secret", () => {
  it("selects explicit columns without the secret", async () => {
    const token = await makeToken();
    const sqls: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        sqls.push(sql);
        const s: any = {
          bind: vi.fn(() => s),
          first: vi.fn(async () => null),
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
          all: vi.fn(async () => ({ results: [] })),
        };
        return s;
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database;

    const resp = await listBackends(
      new Request("https://service.example/api/backends", { headers: { Authorization: `Bearer ${token}` } }),
      envOf(db),
    );
    expect(resp.status).toBe(200);
    const listSQL = sqls.find((s) => /FROM file_backends/.test(s))!;
    expect(listSQL).not.toMatch(/b\.\*/);
    expect(listSQL).not.toMatch(/upload_secret/);
  });
});

// Mirror of signBackendCapability with an injectable exp, for recomputation.
async function signBackendCapabilityAt(secret: string, key: string, op: string, exp: number): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${key}\n${op}\n${exp}`));
  const b = new Uint8Array(sig);
  let str = "";
  for (let i = 0; i < b.length; i++) str += String.fromCharCode(b[i]);
  return `${exp}.` + btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
