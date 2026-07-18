import { releaseUrl } from "./release";

export default function Home() {
  return (
    <main className="landing">
      <div className="ambient ambientOne" aria-hidden="true" />
      <div className="ambient ambientTwo" aria-hidden="true" />

      <header className="brandBar">
        <a className="brand" href="/" aria-label="OurCord 首页">
          <span className="brandMark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>OurCord</span>
        </a>
        <span className="betaPill">PUBLIC BETA</span>
      </header>

      <section className="hero">
        <div className="copy">
          <h1>朋友在线，<br />数据在你手里。</h1>

          <div className="actions">
            <a className="downloadButton" href={releaseUrl} download>
              <span className="windowsMark" aria-hidden="true"><i /><i /><i /><i /></span>
              <span><strong>下载 Windows Beta</strong><small>Windows 10 / 11 · x64</small></span>
              <span className="arrow" aria-hidden="true">↗</span>
            </a>
          </div>

          <p className="notice">当前安装包未签名，Windows 会显示“未知发布者”提示。</p>
        </div>

        <div className="network" aria-hidden="true">
          <div className="networkGlow" />
          <div className="orbit orbitOne" />
          <div className="orbit orbitTwo" />
          <div className="link linkOne" />
          <div className="link linkTwo" />
          <div className="link linkThree" />
          <div className="node nodeMain"><span>O</span><em>you</em></div>
          <div className="node nodeA"><span>A</span></div>
          <div className="node nodeB"><span>B</span></div>
          <div className="node nodeC"><span>C</span></div>
        </div>
      </section>
    </main>
  );
}
