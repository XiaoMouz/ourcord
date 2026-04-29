import { Env } from "./types";
import { signToken, makeToken, generateOTP, generateId, getJwtSecret, checkBodySize } from "./auth";

const OTP_TTL = 10 * 60; // 10 minutes
// OAuth `state` lifetime: long enough for an interactive consent flow (incl.
// the user typing 2FA codes), short enough that a stolen state is useless.
const OAUTH_STATE_TTL = 10 * 60;

// POST /api/auth/otp/request — send OTP to email
export async function requestOTP(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 1024);
  if (tooBig) return tooBig;
  const body = await request.json<{ email: string }>();
  if (!body.email || !body.email.includes("@")) {
    return json({ error: "valid email required" }, 400);
  }

  const email = body.email.toLowerCase().trim();
  const otp = generateOTP();
  const key = `otp:${email}`;

  // Store OTP in KV with TTL
  await env.KV.put(key, otp, { expirationTtl: OTP_TTL });

  // Send OTP email (via external email API configured in env)
  // K1: in production with no email provider configured, sendOTPEmail throws
  // rather than silently no-op'ing. Catch here and surface 503 so callers
  // know the OTP was never sent (instead of falsely reporting success).
  try {
    await sendOTPEmail(env, email, otp);
  } catch (e) {
    console.error(`[otp] sendOTPEmail failed for ${email}:`, e);
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

  const email = body.email.toLowerCase().trim();
  const key = `otp:${email}`;
  const stored = await env.KV.get(key);

  if (!stored || stored !== body.otp) {
    return json({ error: "Invalid or expired OTP" }, 401);
  }

  // Delete OTP after successful verification
  await env.KV.delete(key);

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

  const payload = makeToken(user.id, email);
  const token = await signToken(payload, getJwtSecret(env));
  return json({ token, user_id: user.id });
}

// GET /api/auth/oauth/:provider — redirect to OAuth provider
export async function oauthRedirect(request: Request, env: Env, provider: string): Promise<Response> {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/auth/oauth/${provider}/callback`;

  // Generate a single-use `state` and persist it in KV. The callback handler
  // requires the same state to be present (and then deletes it), preventing
  // OAuth login-CSRF where an attacker tricks a victim's browser into
  // completing the attacker's authorization flow.
  const state = crypto.randomUUID();
  await env.KV.put(`oauth_state:${state}`, provider, { expirationTtl: OAUTH_STATE_TTL });

  if (provider === "google") {
    const params = new URLSearchParams({
      client_id: env.OAUTH_GOOGLE_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
    });
    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  }

  if (provider === "github") {
    const params = new URLSearchParams({
      client_id: env.OAUTH_GITHUB_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      scope: "user:email",
      state,
    });
    return Response.redirect(`https://github.com/login/oauth/authorize?${params}`);
  }

  // Unknown provider: clean up the state so we don't leak KV entries.
  await env.KV.delete(`oauth_state:${state}`);
  return json({ error: "Unknown provider" }, 400);
}

// GET /api/auth/oauth/:provider/callback — handle OAuth callback
export async function oauthCallback(request: Request, env: Env, provider: string): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return json({ error: "Missing code" }, 400);
  if (!state) return json({ error: "Missing state" }, 400);

  // Validate `state` matches a recently-issued one for this provider, then
  // delete to prevent reuse. KV.delete is best-effort but acceptable for a
  // single-use token whose TTL bounds replay anyway.
  const stateKey = `oauth_state:${state}`;
  const issuedFor = await env.KV.get(stateKey);
  if (!issuedFor || issuedFor !== provider) {
    return json({ error: "Invalid or expired state" }, 400);
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
    console.error(`[oauth] ${provider} callback failed:`, e);
    const isDev = (env.ENVIRONMENT ?? "development") === "development";
    return json(
      isDev ? { error: "OAuth failed", detail: String(e) } : { error: "OAuth failed" },
      502,
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

  if (user.banned_at) return json({ error: "Account banned" }, 403);

  const payload = makeToken(user.id, email);
  const token = await signToken(payload, getJwtSecret(env));

  // Redirect to app with token (or return JSON in dev)
  const appUrl = `ourcord://auth?token=${encodeURIComponent(token)}`;
  return Response.redirect(appUrl, 302);
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
  // Stub: integrate with Resend / Mailgun / SendGrid via env.EMAIL_API_KEY
  // In development, log the OTP and short-circuit so local flows still work.
  if (env.ENVIRONMENT === "development") {
    console.log(`[DEV] OTP for ${email}: ${otp}`);
    return;
  }
  // K1: in production we have no email provider integration yet. Refuse
  // honestly instead of returning success while never sending anything —
  // a silent no-op here makes OTP login look working in staging/prod and
  // locks every real user out. requestOTP catches this and returns 503.
  if (!env.EMAIL_API_KEY) {
    console.error(`[otp] EMAIL_API_KEY not configured; cannot deliver OTP to ${email}`);
    throw new Error("email provider not configured");
  }
  // TODO: implement email sending via configured provider
  console.error(`[otp] EMAIL_API_KEY present but provider integration not implemented`);
  throw new Error("email provider integration not implemented");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
