import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DialogProvider } from "../dialog";
import DiagnosticsModal from "./DiagnosticsModal";

describe("DiagnosticsModal", () => {
  it("labels the local daemon check separately from peer latency", () => {
    const html = renderToStaticMarkup(
      <DialogProvider>
        <DiagnosticsModal snapshot={{ daemon_available: true }} close={() => {}} onError={() => {}} />
      </DialogProvider>,
    );

    expect(html).toContain("后台响应");
    expect(html).toContain("不代表 Peer 网络延迟");
    expect(html).not.toContain(">Ping<");
  });
});
