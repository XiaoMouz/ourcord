import { Env } from "./types";
import { signToken, makeToken, generateOTP, generateId, getJwtSecret, checkBodySize, constantTimeEqual, isUserBanned, json } from "./auth";
import { log } from "./log";

const OTP_TTL = 10 * 60; // 10 minutes
// P2: cap online brute-force against OTP. After this many wrong submissions
// the OTP is invalidated and the user must request a new one.
const OTP_MAX_FAILS = 5;
// P2: throttle OTP issuance per email to make fail-counter reset attacks
// (request fresh OTP → spend 5 guesses → repeat) noticeable in scale.
const OTP_REQUEST_COOLDOWN = 60;
// OAuth `state` lifetime: long enough for an interactive consent flow (incl.
// the user typing 2FA codes), short enough that a stolen state is useless.
const OAUTH_STATE_TTL = 10 * 60;
// P1: cookie name for OAuth state-binding. The cookie is scoped to the
// callback path so it never leaks to other endpoints.
const OAUTH_CSRF_COOKIE = "oauth_state";
const DESKTOP_MAGIC_TTL = 10 * 60;
const DESKTOP_CODE_TTL = 60;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

function desktopMagicResponse(retryAfter: number): Response {
  return json({
    message: "If the address can receive mail, a sign-in link has been sent",
    expires_in: DESKTOP_MAGIC_TTL,
    retry_after: retryAfter,
  });
}

// POST /api/auth/otp/request — send OTP to email
export async function requestOTP(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 1024);
  if (tooBig) return tooBig;
  const body = await request.json<{ email: string }>();
  if (!body.email || !body.email.includes("@")) {
    return json({ error: "valid email required" }, 400);
  }

  const email = body.email.toLowerCase().trim();
  // P2: per-email cooldown. The companion key has TTL=cooldown so its mere
  // existence means "too soon since last issuance". KV is non-atomic so this
  // is best-effort: a parallel pair of requests can both observe absence and
  // both succeed once. That's acceptable — the goal is to make sustained
  // OTP-reset attacks expensive, not to provide a perfect mutex.
  const cooldownKey = `otp_cooldown:${email}`;
  if (await env.KV.get(cooldownKey)) {
    return json({ error: "OTP recently issued; try again shortly" }, 429);
  }

  const otp = generateOTP();
  const key = `otp:${email}`;

  await env.KV.put(key, otp, { expirationTtl: OTP_TTL });
  await env.KV.put(cooldownKey, "1", { expirationTtl: OTP_REQUEST_COOLDOWN });
  // Reset any prior fail counter so the freshly issued OTP starts at 0.
  await env.KV.delete(`otp_fails:${email}`);

  // Send OTP email (via external email API configured in env)
  // K1: in production with no email provider configured, sendOTPEmail throws
  // rather than silently no-op'ing. Catch here and surface 503 so callers
  // know the OTP was never sent (instead of falsely reporting success).
  try {
    await sendOTPEmail(env, email, otp);
  } catch (e) {
    log({ event: "otp.send_failed", level: "error", email, error: String(e) });
    return json({ error: "OTP delivery not configured" }, 503);
  }

  return json({ message: "OTP sent", expires_in: OTP_TTL });
}

// POST /api/auth/otp/verify — verify OTP and issue token
export async function verifyOTP(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 1024);
  if (tooBig) return tooBig;
  const body = await request.json<{ email: string; otp: string }>();
  if (!body.email || !body.otp) return json({ error: "email and otp required" }, 400);
  // P2: shape check before any KV lookup. An attacker spamming non-numeric
  // payloads must not even consume KV reads or the fail counter slot.
  if (typeof body.otp !== "string" || !/^\d{6}$/.test(body.otp)) {
    return json({ error: "Invalid or expired OTP" }, 401);
  }

  const email = body.email.toLowerCase().trim();
  const key = `otp:${email}`;
  const failKey = `otp_fails:${email}`;
  const stored = await env.KV.get(key);

  if (!stored || !constantTimeEqual(stored, body.otp)) {
    // P2: increment KV fail counter; once over OTP_MAX_FAILS, invalidate the
    // OTP outright so the attacker has to wait for the cooldown + new code.
    // KV read-modify-write is non-atomic so a few simultaneous attempts may
    // race and undercount; this is documented in AGENTS.md as a known
    // best-effort defense (Phase-2: migrate to D1 row or Durable Object).
    const cur = parseInt((await env.KV.get(failKey)) ?? "0", 10) || 0;
    const next = cur + 1;
    await env.KV.put(failKey, String(next), { expirationTtl: OTP_TTL });
    if (next >= OTP_MAX_FAILS) {
      await env.KV.delete(key);
    }
    return json({ error: "Invalid or expired OTP" }, 401);
  }

  // Delete OTP and the fail counter on success.
  await env.KV.delete(key);
  await env.KV.delete(failKey);

  // Get or create user
  let user = await env.DB
    .prepare("SELECT id, email, banned_at FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; email: string; banned_at: number | null }>();

  if (!user) {
    const id = generateId();
    const now = Math.floor(Date.now() / 1000);
    await env.DB
      .prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,?,?)")
      .bind(id, email, email.split("@")[0], now)
      .run();
    user = { id, email, banned_at: null };
  }

  if (user.banned_at) {
    return json({ error: "Account banned" }, 403);
  }
  // P3: also consult the bans table; users.banned_at is currently never
  // written to but `bans` rows from /api/ban with target_type='user' must
  // block fresh-token issuance.
  if (await isUserBanned(user.id, env.DB)) {
    return json({ error: "User is banned" }, 403);
  }

  const payload = makeToken(user.id, email);
  const token = await signToken(payload, getJwtSecret(env));
  return json({ token, user_id: user.id });
}

// GET /api/auth/oauth/:provider — redirect to OAuth provider
export async function oauthRedirect(request: Request, env: Env, provider: string): Promise<Response> {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/auth/oauth/${provider}/callback`;

  // P1: bind the OAuth flow to the originating browser. Generate a `state`
  // (sent to the provider, returned via query string) AND a `csrf` value
  // (set as an HttpOnly cookie scoped to the callback path). The KV record
  // stores both so the callback can:
  //   1. confirm the state was issued by us for this provider, and
  //   2. confirm the cookie value matches — proving the callback is hitting
  //      the same browser that initiated the flow.
  // Without (2), an attacker can pre-stage their own state+code and trick
  // the victim's browser into completing the attacker's flow, silently
  // logging the victim into the attacker's account.
  const state = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const desktopChallenge = url.searchParams.get("code_challenge");
  if (desktopChallenge !== null && !PKCE_CHALLENGE_RE.test(desktopChallenge)) {
    return json({ error: "valid S256 code_challenge required" }, 400);
  }
  await env.KV.put(
    `oauth_state:${state}`,
    JSON.stringify({ provider, csrf, desktopChallenge }),
    { expirationTtl: OAUTH_STATE_TTL },
  );

  const cookiePath = `/api/auth/oauth/${provider}/callback`;
  const setCookie =
    `${OAUTH_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; SameSite=Lax; ` +
    `Max-Age=${OAUTH_STATE_TTL}; Path=${cookiePath}`;

  let location: string | null = null;
  if (provider === "google") {
    const params = new URLSearchParams({
      client_id: env.OAUTH_GOOGLE_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
    });
    location = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  } else if (provider === "github") {
    const params = new URLSearchParams({
      client_id: env.OAUTH_GITHUB_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      scope: "user:email",
      state,
    });
    location = `https://github.com/login/oauth/authorize?${params}`;
  }

  if (!location) {
    // Unknown provider: clean up the state so we don't leak KV entries.
    await env.KV.delete(`oauth_state:${state}`);
    return json({ error: "Unknown provider" }, 400);
  }

  // Use an explicit Response to attach Set-Cookie alongside the redirect;
  // `Response.redirect()` returns an immutable Response whose headers can't
  // be augmented.
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Set-Cookie": setCookie },
  });
}

// GET /api/auth/oauth/:provider/callback — handle OAuth callback
export async function oauthCallback(request: Request, env: Env, provider: string): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookiePath = `/api/auth/oauth/${provider}/callback`;
  // Always clear the CSRF cookie on the way out, success or failure, so a
  // partially completed flow can't leave a reusable cookie behind.
  const clearCookie = `${OAUTH_CSRF_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=${cookiePath}`;

  if (!code) return jsonWithCookie({ error: "Missing code" }, 400, clearCookie);
  if (!state) return jsonWithCookie({ error: "Missing state" }, 400, clearCookie);

  // P1: pull the CSRF value the browser was issued at oauthRedirect time.
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const cookieCsrf = parseCookie(cookieHeader, OAUTH_CSRF_COOKIE);
  if (!cookieCsrf) {
    return jsonWithCookie({ error: "Missing OAuth CSRF cookie" }, 400, clearCookie);
  }

  // Validate `state` matches a recently-issued one for this provider, then
  // delete to prevent reuse. KV.delete is best-effort but acceptable for a
  // single-use token whose TTL bounds replay anyway.
  const stateKey = `oauth_state:${state}`;
  const storedRaw = await env.KV.get(stateKey);
  if (!storedRaw) {
    return jsonWithCookie({ error: "Invalid or expired state" }, 400, clearCookie);
  }
  let stored: { provider: string; csrf: string; desktopChallenge?: string | null };
  try {
    stored = JSON.parse(storedRaw) as { provider: string; csrf: string; desktopChallenge?: string | null };
  } catch {
    await env.KV.delete(stateKey);
    return jsonWithCookie({ error: "Invalid state record" }, 400, clearCookie);
  }
  if (stored.provider !== provider || !constantTimeEqual(stored.csrf, cookieCsrf)) {
    await env.KV.delete(stateKey);
    return jsonWithCookie({ error: "OAuth CSRF mismatch" }, 400, clearCookie);
  }
  await env.KV.delete(stateKey);

  const redirectUri = `${url.origin}/api/auth/oauth/${provider}/callback`;

  let email: string;
  try {
    email = await fetchOAuthEmail(env, provider, code, redirectUri);
  } catch (e) {
    // L1: do not leak provider error details (URLs, status codes, partial
    // tokens, stack frames) to the public client. Always log the full error
    // server-side; only echo the message in development.
    log({ event: "oauth.callback_failed", level: "error", provider, error: String(e) });
    const isDev = (env.ENVIRONMENT ?? "development") === "development";
    return jsonWithCookie(
      isDev ? { error: "OAuth failed", detail: String(e) } : { error: "OAuth failed" },
      502,
      clearCookie,
    );
  }

  // Get or create user (same as OTP flow)
  let user = await env.DB
    .prepare("SELECT id, email, banned_at FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; email: string; banned_at: number | null }>();

  if (!user) {
    const id = generateId();
    const now = Math.floor(Date.now() / 1000);
    await env.DB
      .prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,?,?)")
      .bind(id, email, email.split("@")[0], now)
      .run();
    user = { id, email, banned_at: null };
  }

  if (user.banned_at) return jsonWithCookie({ error: "Account banned" }, 403, clearCookie);
  // P3: bans table check (see verifyOTP for rationale).
  if (await isUserBanned(user.id, env.DB)) {
    return jsonWithCookie({ error: "User is banned" }, 403, clearCookie);
  }

  if (stored.desktopChallenge) {
    const appCode = await issueDesktopCode(env, user.id, email, stored.desktopChallenge);
    return new Response(null, {
      status: 302,
      headers: { Location: `ourcord://auth?code=${encodeURIComponent(appCode)}`, "Set-Cookie": clearCookie },
    });
  }

  const payload = makeToken(user.id, email);
  const token = await signToken(payload, getJwtSecret(env));

  // Redirect to app with token (or return JSON in dev). Clear the CSRF cookie
  // alongside the redirect so a successful flow can't leave a reusable cookie.
  const appUrl = `ourcord://auth?token=${encodeURIComponent(token)}`;
  return new Response(null, {
    status: 302,
    headers: { Location: appUrl, "Set-Cookie": clearCookie },
  });
}

// POST /api/auth/desktop/magic — send a browser confirmation link bound to
// the requesting desktop instance's PKCE challenge.
export async function requestDesktopMagic(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 2048);
  if (tooBig) return tooBig;
  let body: { email?: unknown; code_challenge?: unknown };
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  const email = typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
  const challenge = typeof body.code_challenge === "string" ? body.code_challenge : "";
  if (!email.includes("@") || email.length > 254) return json({ error: "valid email required" }, 400);
  if (!PKCE_CHALLENGE_RE.test(challenge)) return json({ error: "valid S256 code_challenge required" }, 400);

  const cooldownKey = `desktop_magic_cooldown:${email}`;
  const now = Math.floor(Date.now() / 1000);
  const cooldownValue = await env.KV.get(cooldownKey);
  if (cooldownValue) {
    const cooldownUntil = Number.parseInt(cooldownValue, 10);
    // Older deployments stored the sentinel "1". Keep the response useful
    // during rollout by conservatively returning the full cooldown for it.
    const retryAfter = cooldownUntil > now
      ? Math.max(1, cooldownUntil - now)
      : OTP_REQUEST_COOLDOWN;
    return desktopMagicResponse(retryAfter);
  }

  const rawToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const tokenHash = await sha256Base64url(rawToken);
  await env.KV.put(`desktop_magic:${tokenHash}`, JSON.stringify({ email, challenge }), {
    expirationTtl: DESKTOP_MAGIC_TTL,
  });
  await env.KV.put(cooldownKey, String(now + OTP_REQUEST_COOLDOWN), { expirationTtl: OTP_REQUEST_COOLDOWN });
  const origin = new URL(request.url).origin;
  const confirmURL = `${origin}/api/auth/desktop/magic/confirm?token=${encodeURIComponent(rawToken)}`;
  try {
    await sendMagicEmail(env, email, confirmURL);
  } catch (e) {
    await Promise.all([
      env.KV.delete(`desktop_magic:${tokenHash}`),
      env.KV.delete(cooldownKey),
    ]);
    log({ event: "desktop_magic.send_failed", level: "error", email, error: String(e) });
    return json({ error: "Magic link delivery not configured" }, 503);
  }
  return desktopMagicResponse(OTP_REQUEST_COOLDOWN);
}

// GET intentionally does not consume the token: mail security scanners often
// prefetch links. Only the explicit form POST authorizes the app.
export async function confirmDesktopMagicPage(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const escaped = token.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return new Response(`<!doctype html><meta charset="utf-8"><title>Sign in to OurCord</title><style>body{font:16px system-ui;background:#111827;color:#f9fafb;display:grid;place-items:center;min-height:100vh}main{max-width:28rem;padding:2rem;background:#1f2937;border-radius:16px}button{padding:.8rem 1.2rem;border:0;border-radius:8px;background:#6366f1;color:white;font-weight:700}</style><main><h1>Sign in to OurCord</h1><p>Confirm this sign-in on the computer where you requested it.</p><form method="post"><input type="hidden" name="token" value="${escaped}"><button>Confirm sign-in</button></form></main>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function confirmDesktopMagic(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const rawToken = String(form.get("token") ?? "");
  if (!/^[a-f0-9]{64}$/.test(rawToken)) return invalidDesktopMagic(request);
  const key = `desktop_magic:${await sha256Base64url(rawToken)}`;
  const storedRaw = await env.KV.get(key);
  if (!storedRaw) return invalidDesktopMagic(request);
  await env.KV.delete(key);
  let stored: { email: string; challenge: string };
  try { stored = JSON.parse(storedRaw); } catch { return json({ error: "Invalid link" }, 400); }
  if (!PKCE_CHALLENGE_RE.test(stored.challenge)) return json({ error: "Invalid link" }, 400);
  const user = await getOrCreateUser(env, stored.email);
  if (user.banned_at || await isUserBanned(user.id, env.DB)) return json({ error: "Account banned" }, 403);
  const code = await issueDesktopCode(env, user.id, user.email, stored.challenge);
  return desktopMagicResultPage(`<h1>Finish signing in</h1><p>Your email is confirmed. Open OurCord on the computer where you requested this sign-in.</p><p><a href="ourcord://auth?code=${encodeURIComponent(code)}">Open OurCord</a></p><p>If the app did not open, try the button again. This authorization expires in ${DESKTOP_CODE_TTL} seconds. After that, request a new email from OurCord.</p>`, 200);
}

function invalidDesktopMagic(request: Request): Response {
  if (!(request.headers.get("Accept") ?? "").includes("text/html")) {
    return json({ error: "Invalid or expired link" }, 400);
  }
  return desktopMagicResultPage("<h1>This sign-in link is no longer available</h1><p>The link may have expired or already been confirmed. If you still have the confirmation page open, use its Open OurCord button. Otherwise, return to OurCord and request a new sign-in email.</p>", 400);
}

function desktopMagicResultPage(content: string, status: number): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to OurCord</title><style>body{font:16px system-ui;background:#111827;color:#f9fafb;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;margin:1rem;padding:2rem;background:#1f2937;border-radius:16px}a{display:inline-block;padding:.8rem 1.2rem;border-radius:8px;background:#6366f1;color:white;font-weight:700;text-decoration:none}a:focus-visible{outline:3px solid white;outline-offset:4px}</style></head><body><main>${content}</main></body></html>`, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function exchangeDesktopCode(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 2048);
  if (tooBig) return tooBig;
  let body: { code?: unknown; code_verifier?: unknown };
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  const code = typeof body.code === "string" ? body.code : "";
  const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
  if (!/^[a-f0-9]{64}$/.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return json({ error: "invalid authorization code" }, 400);
  }
  const hash = await sha256Base64url(code);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    "SELECT user_id, email, code_challenge, expires_at FROM desktop_auth_codes WHERE code_hash = ?",
  ).bind(hash).first<{ user_id: string; email: string; code_challenge: string; expires_at: number }>();
  if (!row || row.expires_at < now || !constantTimeEqual(await sha256Base64url(verifier), row.code_challenge)) {
    return json({ error: "invalid or expired authorization code" }, 401);
  }
  // Delete first and issue only if this caller won the one-time consume race.
  const deleted = await env.DB.prepare("DELETE FROM desktop_auth_codes WHERE code_hash = ?")
    .bind(hash).run();
  if ((deleted.meta?.changes ?? 0) !== 1) return json({ error: "authorization code already used" }, 401);
  if (await isUserBanned(row.user_id, env.DB)) return json({ error: "Account banned" }, 403);
  const token = await signToken(makeToken(row.user_id, row.email), getJwtSecret(env));
  return json({ token, user_id: row.user_id });
}

async function issueDesktopCode(env: Env, userId: string, email: string, challenge: string): Promise<string> {
  const code = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO desktop_auth_codes (code_hash, user_id, email, code_challenge, expires_at) VALUES (?,?,?,?,?)",
  ).bind(await sha256Base64url(code), userId, email, challenge, now + DESKTOP_CODE_TTL).run();
  return code;
}

export async function cleanupExpiredDesktopCodes(env: Env): Promise<number> {
  // Match exchangeDesktopCode's strict expiry boundary. Use the expiry index
  // and one bounded batch so old abandoned logins cannot make a cron unbounded.
  const result = await env.DB.prepare(
    `DELETE FROM desktop_auth_codes WHERE code_hash IN (
       SELECT code_hash FROM desktop_auth_codes
       WHERE expires_at < ? ORDER BY expires_at LIMIT 500
     )`,
  ).bind(Math.floor(Date.now() / 1000)).run();
  return result.meta.changes;
}

async function getOrCreateUser(env: Env, email: string): Promise<{ id: string; email: string; banned_at: number | null }> {
  let user = await env.DB.prepare("SELECT id, email, banned_at FROM users WHERE email = ?")
    .bind(email).first<{ id: string; email: string; banned_at: number | null }>();
  if (!user) {
    const id = generateId();
    await env.DB.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,?,?)")
      .bind(id, email, email.split("@")[0], Math.floor(Date.now() / 1000)).run();
    user = { id, email, banned_at: null };
  }
  return user;
}

async function sha256Base64url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sendMagicEmail(env: Env, email: string, confirmURL: string): Promise<void> {
  if (env.ENVIRONMENT === "development") {
    log({ event: "desktop_magic.dev_print", email, confirm_url: confirmURL });
    return;
  }
  if (!env.EMAIL_API_KEY) throw new Error("email provider not configured");
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "OurCord <noreply@ourcord.invalid>",
      to: [email],
      subject: "Sign in to OurCord",
      text: `Open this link to sign in to OurCord:\n\n${confirmURL}\n\nIt expires in 10 minutes.`,
    }),
  });
  if (!resp.ok) throw new Error(`resend api error: ${resp.status}`);
}

async function fetchOAuthEmail(env: Env, provider: string, code: string, redirectUri: string): Promise<string> {
  if (provider === "google") {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, redirect_uri: redirectUri,
        client_id: env.OAUTH_GOOGLE_CLIENT_ID ?? "",
        client_secret: env.OAUTH_GOOGLE_CLIENT_SECRET ?? "",
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) throw new Error(`google token endpoint: HTTP ${tokenRes.status}`);
    const tokenData = await tokenRes.json<{ id_token?: string }>();
    if (!tokenData.id_token) throw new Error("google: missing id_token in response");
    // The id_token is fetched server-to-server from Google with our client
    // secret, so signature verification is skipped — but the *parse* still
    // has to be defensive against malformed responses.
    const parts = tokenData.id_token.split(".");
    if (parts.length !== 3) throw new Error("google: malformed id_token");
    let claims: { email?: string };
    try {
      claims = JSON.parse(b64urlDecode(parts[1])) as { email?: string };
    } catch (e) {
      throw new Error(`google: id_token payload parse failed: ${String(e)}`);
    }
    if (!claims.email) throw new Error("google: id_token missing email claim");
    return claims.email.toLowerCase();
  }

  if (provider === "github") {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        code, redirect_uri: redirectUri,
        client_id: env.OAUTH_GITHUB_CLIENT_ID ?? "",
        client_secret: env.OAUTH_GITHUB_CLIENT_SECRET ?? "",
      }),
    });
    if (!tokenRes.ok) throw new Error(`github token endpoint: HTTP ${tokenRes.status}`);
    const tokenData = await tokenRes.json<{ access_token?: string }>();
    if (!tokenData.access_token) throw new Error("github: missing access_token");
    const emailRes = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "ourcord" },
    });
    if (!emailRes.ok) throw new Error(`github emails endpoint: HTTP ${emailRes.status}`);
    const emails = await emailRes.json<Array<{ email: string; primary: boolean; verified: boolean }>>();
    const primary = emails.find((e) => e.primary && e.verified);
    if (!primary) throw new Error("No verified primary email on GitHub account");
    return primary.email.toLowerCase();
  }

  throw new Error("Unknown provider");
}

// b64urlDecode decodes a base64url string (no padding) into a UTF-8 string.
// JWT claim segments use this encoding, not the standard base64 atob expects.
function b64urlDecode(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return atob(padded + "=".repeat(padLen));
}

async function sendOTPEmail(env: Env, email: string, otp: string): Promise<void> {
  // Dev short-circuit: log to console so local flows work without provider.
  if (env.ENVIRONMENT === "development") {
    log({ event: "otp.dev_print", email, otp, msg: `[DEV] OTP for ${email}: ${otp}` });
    return;
  }
  // V1: production must have a provider configured. Fail loud rather than
  // silently no-op'ing — caller (requestOTP) returns 503 on throw.
  if (!env.EMAIL_API_KEY) {
    log({ event: "otp.email_provider_unconfigured", level: "error", email });
    throw new Error("email provider not configured");
  }
  const from = env.EMAIL_FROM || "OurCord <noreply@ourcord.invalid>";

  // Per-recipient daily rate limit. KV read-modify-write is non-atomic but
  // acceptable here — worst case we let one extra email through under heavy
  // concurrency. Cap defaults to 10/day; admins can raise via env.
  const cap = parseInt(env.EMAIL_RATE_LIMIT_PER_DAY || "10", 10);
  const rlKey = `email_quota:${email}:${new Date().toISOString().slice(0, 10)}`;
  const sent = parseInt((await env.KV.get(rlKey)) || "0", 10);
  if (sent >= cap) {
    throw new Error(`recipient daily email quota (${cap}) exhausted`);
  }

  // Resend API: https://resend.com/docs/api-reference/emails/send-email
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.EMAIL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Your OurCord login code",
      text: `Your OurCord verification code is: ${otp}\n\nThis code expires in 5 minutes. If you did not request it, ignore this email.`,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    // V1: never include the OTP itself in the upstream error log; the OTP is
    // already in the request body Resend received and our own log here is
    // about delivery failure mode, not credential leakage.
    log({ event: "otp.resend_failed", level: "error", status: resp.status, body: detail.slice(0, 200) });
    throw new Error(`resend api error: ${resp.status}`);
  }
  // Best-effort quota increment (non-atomic; see comment above).
  await env.KV.put(rlKey, String(sent + 1), { expirationTtl: 60 * 60 * 26 });
}

// jsonWithCookie returns a JSON response with a Set-Cookie header attached.
// Used by oauthCallback to clear the OAuth CSRF cookie on every exit path.
function jsonWithCookie(data: unknown, status: number, setCookie: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Set-Cookie": setCookie },
  });
}

// parseCookie extracts a single cookie value from a Cookie header. Returns
// null if absent. Cookies are split on `;` per RFC 6265.
function parseCookie(header: string, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}
