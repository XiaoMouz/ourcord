import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TitleBar from "./TitleBar";

describe("TitleBar", () => {
  it("renders a daisyUI title bar with a ready update action", () => {
    const html = renderToStaticMarkup(<TitleBar
      update={{ status: "ready", version: "0.1.0-beta.8" }}
      onInstall={() => undefined}
      onRetry={() => undefined}
    />);
    expect(html).toContain('class="navbar');
    expect(html).toContain("data-tauri-drag-region");
    expect(html).toContain("更新 0.1.0-beta.8");
    expect(html).toContain("最大化或还原");
    expect(html).not.toContain("modal");
  });

  it("shows silent download progress", () => {
    const html = renderToStaticMarkup(<TitleBar
      update={{ status: "downloading", version: "0.1.0-beta.8", downloadedBytes: 50, totalBytes: 100 }}
      onInstall={() => undefined}
      onRetry={() => undefined}
    />);
    expect(html).toContain("下载更新 50%");
    expect(html).toContain("loading loading-spinner");
  });
});
