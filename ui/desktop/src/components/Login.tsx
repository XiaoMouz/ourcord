import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

export default function Login({ busy, notice, error, loginURLs, onMagic }: {
  busy: boolean;
  notice: string;
  error: string;
  loginURLs?: { google_url: string; github_url: string };
  onMagic: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  return <main className="login-shell">
    <section className="login-card">
      <div className="brand"><div className="brand-mark">O</div><h1>OurCord</h1></div>
      <h2>欢迎回来</h2>
      <label>邮箱地址<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" onKeyDown={(e) => e.key === "Enter" && onMagic(email)} /></label>
      <button className="primary" disabled={busy || !email.includes("@")} onClick={() => onMagic(email)}>发送 Magic Link</button>
      <div className="divider"><span>或</span></div>
      <div className="oauth">
        <button disabled={!loginURLs} onClick={() => loginURLs && void openUrl(loginURLs.google_url)}>G&nbsp; 使用 Google</button>
        <button disabled={!loginURLs} onClick={() => loginURLs && void openUrl(loginURLs.github_url)}>⌁&nbsp; 使用 GitHub</button>
      </div>
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </section>
    <aside className="login-art">
      <div className="mesh"><i/><i/><i/><i/></div>
    </aside>
  </main>;
}
