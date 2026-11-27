import { useEffect, useState, type CSSProperties } from "react";
import { InitialAvatar } from "./ui";

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

  return <main className="hero min-h-full bg-base-200">
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
              placeholder="you@example.com" onKeyDown={(e) => e.key === "Enter" && !coolingDown && onMagic(email)} />
          </fieldset>
          <button className="btn btn-primary btn-block" disabled={busy || coolingDown || !email.includes("@")} onClick={() => onMagic(email)}>
            {busy && <span className="loading loading-spinner loading-sm" />}
            {coolingDown ? <span aria-live="polite">
              <span className={`countdown font-mono${animateCooldown ? "" : " countdown-initial"}`}>
                <span style={{ "--value": cooldownSeconds } as CSSProperties} aria-label={String(cooldownSeconds)}>{cooldownSeconds}</span>
              </span> 秒后可重新发送
            </span> : "发送 Magic Link"}
          </button>
          <div className="divider text-xs text-base-content/40">或</div>
          <div className="grid grid-cols-2 gap-3">
            <button className="btn" disabled={busy || !loginURLs || !onOAuth} onClick={() => onOAuth?.("google")}>G&nbsp; Google</button>
            <button className="btn" disabled={busy || !loginURLs || !onOAuth} onClick={() => onOAuth?.("github")}>⌁&nbsp; GitHub</button>
          </div>
        </div>
      </section>
    </div>
  </main>;
}
