import { useEffect, useState, type CSSProperties } from "react";

export default function Login({ busy, cooldownSeconds, loginURLs, onMagic, onOAuth }: {
  busy: boolean;
  cooldownSeconds: number;
  loginURLs?: { google_url: string; github_url: string };
  onMagic: (email: string) => void;
  onOAuth?: (provider: "google" | "github") => void;
}) {
  const [email, setEmail] = useState("");
  const coolingDown = cooldownSeconds > 0;
  const [animateCooldown, setAnimateCooldown] = useState(false);

  useEffect(() => {
    if (!coolingDown) {
      setAnimateCooldown(false);
      return;
    }
    const frame = requestAnimationFrame(() => setAnimateCooldown(true));
    return () => cancelAnimationFrame(frame);
  }, [coolingDown]);

  const address = email.trim();
  const canSend = !busy && !coolingDown && address.includes("@");
  return <main className="login-layout">

    <form className="login-form" onSubmit={(event) => {
      event.preventDefault();
      if (canSend) onMagic(address);
    }}>
      <h1>登录</h1>
      <label htmlFor="login-email">邮箱地址</label>
      <input id="login-email" className="input w-full" type="email" required autoComplete="email"
        value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" />
      <button className="btn btn-primary w-full" type="submit" disabled={!canSend}>
        {busy && <span className="loading loading-spinner loading-sm" />}
        {coolingDown ? <span aria-live="polite">
          <span className={`countdown font-mono${animateCooldown ? "" : " countdown-initial"}`}>
            <span style={{ "--value": cooldownSeconds } as CSSProperties} aria-label={String(cooldownSeconds)}>{cooldownSeconds}</span>
          </span> 秒后可重新发送
        </span> : "发送登录链接"}
      </button>
      <div className="divider text-xs">或</div>
      <button type="button" className="btn w-full" disabled={busy || !loginURLs || !onOAuth} onClick={() => onOAuth?.("google")}>使用 Google 登录</button>
      <button type="button" className="btn w-full" disabled={busy || !loginURLs || !onOAuth} onClick={() => onOAuth?.("github")}>使用 GitHub 登录</button>
    </form>
  </main>;
}
