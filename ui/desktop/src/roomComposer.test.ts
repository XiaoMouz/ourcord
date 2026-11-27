import { describe, expect, it } from "vitest";
import { RoomComposer } from "./roomComposer";

describe("room drafts", () => {
  it("keeps later edits even when their text matches the message being acknowledged", () => {
    const composer = new RoomComposer();
    composer.edit("参加");
    const attempt = composer.begin("send")!;
    composer.edit("");
    composer.edit("参加");
    composer.sent(attempt.revision);
    composer.finish();
    expect(composer.snapshot().text).toBe("参加");
  });

  it("locks the room through attachment selection and retains the caption after cancellation", () => {
    const composer = new RoomComposer();
    composer.edit("录音");
    composer.begin("upload");
    expect(composer.begin("send")).toBeNull();
    composer.finish();
    const retry = composer.begin("upload")!;
    expect(retry.text).toBe("录音");
    composer.sent(retry.revision);
    composer.finish();
    expect(composer.snapshot()).toMatchObject({ text: "", pending: null });
  });
});
