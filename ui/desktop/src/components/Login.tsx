import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { InitialAvatar } from "./ui";

export default function Login({ busy, notice, error, loginURLs, onMagic }: {
  busy: boolean;
  notice: string;
  error: string;
  loginURLs?: { google_url: string; github_url: string };
  onMagic: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  return <main className="hero min-h-screen bg-base-200">
    <div className="hero-content w-full max-w-md">
      <section className="card card-border w-full bg-base-100 shadow-2xl">
        <div className="card-body gap-5 p-8">
          <div className="flex items-center gap-3">
            <InitialAvatar name="OurCord" size="lg" />
            <h1 className="text-2xl font-semibold tracking-tight">OurCord</h1>
          </div>
          <h2 className="card-title text-3xl">欢迎回来</h2>
          <fieldset className="fieldset">
            <legend className="fieldset-legend">邮箱地址</legend>
            <input className="input w-full" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com" onKeyDown={(e) => e.key === "Enter" && onMagic(email)} />
          </fieldset>
          <button className="btn btn-primary btn-block" disabled={busy || !email.includes("@")} onClick={() => onMagic(email)}>
            {busy && <span className="loading loading-spinner loading-sm" />}发送 Magic Link
          </button>
          <div className="divider text-xs text-base-content/40">或</div>
          <div className="grid grid-cols-2 gap-3">
            <button className="btn" disabled={!loginURLs} onClick={() => loginURLs && void openUrl(loginURLs.google_url)}>G&nbsp; Google</button>
            <button className="btn" disabled={!loginURLs} onClick={() => loginURLs && void openUrl(loginURLs.github_url)}>⌁&nbsp; GitHub</button>
          </div>
          {notice && <div role="alert" className="alert alert-success alert-soft text-sm">{notice}</div>}
          {error && <div role="alert" className="alert alert-error alert-soft text-sm">{error}</div>}
        </div>
      </section>
    </div>
  </main>;
}
