import { useEffect, useState, type CSSProperties } from "react";

export default function Login({ busy, cooldownSeconds, loginURLs, onMagic, onOAuth }: {
  busy: boolean;
  cooldownSeconds: number;
  loginURLs?: { google_url: string; github_url: string };
  onMagic: (email: string) => void;
  onOAuth?: (provider: "google" | "github") => void;
}) {
  const coolingDown = cooldownSeconds > 0;
  const sendUnavailable = busy || coolingDown;
  const [animateCooldown, setAnimateCooldown] = useState(false);

  useEffect(() => {
    if (!coolingDown) {
      setAnimateCooldown(false);
      return;
    }
    const frame = requestAnimationFrame(() => setAnimateCooldown(true));
    return () => cancelAnimationFrame(frame);
  }, [coolingDown]);

  return <main className="login-layout">
    <section className="login-form">
      <h1>登录</h1>
      <form className="grid gap-3" onSubmit={(event) => {
        event.preventDefault();
        const email = new FormData(event.currentTarget).get("email");
        if (!sendUnavailable && typeof email === "string") onMagic(email);
      }}>
        <label htmlFor="login-email">邮箱地址</label>
        <input id="login-email" className="input w-full" type="email" name="email" required
          autoComplete="email" placeholder="name@example.com" />
        <button className="btn btn-primary w-full" type="submit" disabled={sendUnavailable}>
          {busy && <span className="loading loading-spinner loading-sm" />}
          {coolingDown ? <span aria-live="polite">
            <span className={`countdown font-mono${animateCooldown ? "" : " countdown-initial"}`}>
              <span style={{ "--value": cooldownSeconds } as CSSProperties} aria-label={String(cooldownSeconds)}>{cooldownSeconds}</span>
            </span> 秒后可重新发送
          </span> : "发送登录链接"}
        </button>
      </form>
      <div className="divider text-xs">或</div>
      <button type="button" className="btn w-full" disabled={busy || !loginURLs || !onOAuth} onClick={() => onOAuth?.("google")}>使用 Google 登录</button>
      <button type="button" className="btn w-full" disabled={busy || !loginURLs || !onOAuth} onClick={() => onOAuth?.("github")}>使用 GitHub 登录</button>
    </section>
  </main>;
}
