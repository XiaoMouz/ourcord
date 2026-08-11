import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Login from "./Login";

describe("Login", () => {
  it("keeps the sign-in controls without marketing or credential copy", () => {
    const html = renderToStaticMarkup(
      <Login busy={false} notice="" error="" onMagic={() => undefined} />,
    );

    expect(html).toContain("OurCord");
    expect(html).toContain("欢迎回来");
    expect(html).toContain("邮箱地址");
    expect(html).toContain('class="card card-border');
    expect(html).toContain('class="input');
    expect(html).toContain('class="btn btn-primary');
    expect(html).not.toContain("朋友在线");
    expect(html).not.toContain("使用邮箱链接或已有账号继续");
    expect(html).not.toContain("系统凭据库");
    expect(html).not.toContain("属于你们的小群体网络");
  });
});
