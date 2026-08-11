import { macReleaseUrl, windowsReleaseUrl } from "./release";

export default function Home() {
  return (
    <main className="landing">
      <div className="metalGrain" aria-hidden="true" />

      <header className="brandBar">
        <a className="brand" href="/" aria-label="OurCord 首页">OurCord</a>
        <span className="buildLabel">PUBLIC BETA</span>
      </header>

      <section className="downloadHero" aria-labelledby="product-name">
        <h1 id="product-name">OurCord</h1>

        <div className="metalRule" aria-hidden="true"><span /></div>

        <div className="downloads" aria-label="客户端下载">
          <a className="downloadCard" href={windowsReleaseUrl} download>
            <span className="platform">Windows</span>
            <strong>下载 x64 安装包</strong>
            <small>Windows 10 / 11</small>
            <span className="downloadArrow" aria-hidden="true">&#8595;</span>
          </a>

          <a className="downloadCard" href={macReleaseUrl} download>
            <span className="platform">macOS</span>
            <strong>下载 Apple Silicon 测试版</strong>
            <small>macOS 12+ · UI / 账户测试</small>
            <span className="downloadArrow" aria-hidden="true">&#8595;</span>
          </a>
        </div>

        <p className="releaseNote">
          测试版暂未经过平台商店签名或 Apple 公证，首次打开会显示安全提示。
        </p>
      </section>

      <footer className="landingFooter">
        <span>OURCORD / DESKTOP</span>
        <span>2026</span>
      </footer>
    </main>
  );
}
