import { Env } from "./types";
import { signToken, makeToken, generateOTP, generateId } from "./auth";

const OTP_TTL = 10 * 60; // 10 minutes

// POST /api/auth/otp/request — send OTP to email
export async function requestOTP(request: Request, env: Env): Promise<Response> {
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
  await sendOTPEmail(env, email, otp);

  return json({ message: "OTP sent", expires_in: OTP_TTL });
}

// POST /api/auth/otp/verify — verify OTP and issue token
export async function verifyOTP(request: Request, env: Env): Promise<Response> {
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
  const token = await signToken(payload, env.JWT_SECRET ?? "dev-secret-change-me");
  return json({ token, user_id: user.id });
}

// GET /api/auth/oauth/:provider — redirect to OAuth provider
export async function oauthRedirect(request: Request, env: Env, provider: string): Promise<Response> {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/auth/oauth/${provider}/callback`;

  if (provider === "google") {
    const params = new URLSearchParams({
      client_id: env.OAUTH_GOOGLE_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: crypto.randomUUID(),
    });
    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  }

  if (provider === "github") {
    const params = new URLSearchParams({
      client_id: env.OAUTH_GITHUB_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      scope: "user:email",
      state: crypto.randomUUID(),
    });
    return Response.redirect(`https://github.com/login/oauth/authorize?${params}`);
  }

  return json({ error: "Unknown provider" }, 400);
}

// GET /api/auth/oauth/:provider/callback — handle OAuth callback
export async function oauthCallback(request: Request, env: Env, provider: string): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return json({ error: "Missing code" }, 400);

  const redirectUri = `${url.origin}/api/auth/oauth/${provider}/callback`;

  let email: string;
  try {
    email = await fetchOAuthEmail(env, provider, code, redirectUri);
  } catch (e) {
    return json({ error: "OAuth failed", detail: String(e) }, 502);
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
  const token = await signToken(payload, env.JWT_SECRET ?? "dev-secret-change-me");

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
    const tokenData = await tokenRes.json<{ id_token: string }>();
    // Decode JWT id_token to get email (no verification needed, from Google directly)
    const parts = tokenData.id_token.split(".");
    const claims = JSON.parse(atob(parts[1])) as { email: string };
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
    const tokenData = await tokenRes.json<{ access_token: string }>();
    const emailRes = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "ourcord" },
    });
    const emails = await emailRes.json<Array<{ email: string; primary: boolean; verified: boolean }>>();
    const primary = emails.find((e) => e.primary && e.verified);
    if (!primary) throw new Error("No verified primary email on GitHub account");
    return primary.email.toLowerCase();
  }

  throw new Error("Unknown provider");
}

async function sendOTPEmail(env: Env, email: string, otp: string): Promise<void> {
  // Stub: integrate with Resend / Mailgun / SendGrid via env.EMAIL_API_KEY
  // In development, log the OTP
  if (env.ENVIRONMENT === "development") {
    console.log(`[DEV] OTP for ${email}: ${otp}`);
    return;
  }
  // TODO: implement email sending via configured provider
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
