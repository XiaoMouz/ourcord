export function shouldSendMessage(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "isComposing" | "keyCode">): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
    && !event.isComposing && event.keyCode !== 229;
}
