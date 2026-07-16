const releaseUrl = "/downloads/OurCord_0.1.0-beta.1_x64-setup.exe";

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
          <p className="eyebrow"><span /> 为真正的小群体而生</p>
          <h1>朋友在线，<br />数据在你手里。</h1>
          <p className="intro">
            面向 5–10 人小群体的自托管通讯工具。WireGuard 覆盖网承载语音、文件与远程协作；P2P 优先，中继兜底。
          </p>

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
          <div className="routeLabel routeDirect">P2P direct</div>
          <div className="routeLabel routeRelay">relay fallback</div>
        </div>
      </section>

      <div className="principles" aria-label="OurCord 核心特性">
        <span><i /> P2P first</span>
        <span><i /> WireGuard overlay</span>
        <span><i /> Data sovereign</span>
      </div>
    </main>
  );
}
