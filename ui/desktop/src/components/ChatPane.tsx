import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { bridge, type FileRecord, type Message, type Room } from "../bridge";
import Icon from "./Icon";
import { RoomComposer } from "../roomComposer";
import { shouldSendMessage } from "../composer";
import { mergeMessages, senderIDs } from "../messages";
import { indexMissingFiles } from "../files";
import { formatBytes, parseAttachments } from "../format";
import { ChatSkeleton, Spinner } from "./Skeleton";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { useDialog } from "../dialog";
import { EmptyState, IconButton, InitialAvatar, Tooltip } from "./ui";

const PAGE_SIZE = 50;
const POLL_MS = 3000;
const MAX_POLL_RETRY_MS = 60_000;
type MessagePage = { messages: Message[]; deletion_revision?: number };

function formatTime(createdAt: number): string {
  const date = new Date(createdAt * 1000);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ChatPane({ room, composers, myUserID, canModerate, getName, ensureNames, onError, onCopy, onNotice }: {
  room: Room;
  composers?: Map<string, RoomComposer>;
  myUserID: string;
  canModerate: boolean;
  getName: (userID: string) => string;
  ensureNames: (userIDs: string[]) => Promise<void>;
  onError: (message: string) => void;
  onCopy: (text: string, label: string) => void;
  onNotice: (message: string) => void;
}) {
  const dialog = useDialog();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [composer] = useState(() => {
    const existing = composers?.get(room.id);
    if (existing) return existing;
    const created = new RoomComposer();
    composers?.set(room.id, created);
    return created;
  });
  const { text: draft, pending, sentCount } = useSyncExternalStore(composer.subscribe, composer.snapshot, composer.snapshot);
  const lastSentCount = useRef(sentCount);
  const sending = pending === "send";
  const uploading = pending === "upload";
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedStart, setReachedStart] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [files, setFiles] = useState<Record<string, FileRecord>>({});
  const fileLookup = useRef({ pending: false, retryAt: 0, delay: POLL_MS, missing: new Set<string>() });
  const [downloading, setDownloading] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // Track deletions only for reads already in flight; each read releases its
  // exclusions on completion instead of retaining an ever-growing tombstone set.
  const pendingMessageReads = useRef(new Set<Set<string>>());
  const revisionState = useRef<{ revision?: number; versioned: boolean; epoch: number }>({ versioned: false, epoch: 0 });
  const acceptRevision = useCallback((revision: number | undefined, readEpoch: number) => {
    const state = revisionState.current;
    if (revision === undefined) {
      // Old in-flight replies cannot undo a versioned refresh. A fresh reply
      // after a service rollback can resume legacy behavior after a reset.
      if (readEpoch !== state.epoch) return "stale";
      if (!state.versioned) return "same";
      state.versioned = false;
      state.epoch++;
      return "changed";
    }
    if (state.revision !== undefined && revision < state.revision) return "stale";
    if (!state.versioned && readEpoch !== state.epoch) return "stale";
    const changed = !state.versioned || revision !== state.revision;
    state.revision = revision;
    state.versioned = true;
    if (changed) state.epoch++;
    return changed ? "changed" : "same";
  }, []);

  const poll = useCallback(async () => {
    const readEpoch = revisionState.current.epoch;
    const deleted = new Set<string>();
    pendingMessageReads.current.add(deleted);
    try {
      const data = await bridge<MessagePage>("messages.list", { room_id: room.id, limit: PAGE_SIZE });
      const revision = acceptRevision(data.deletion_revision, readEpoch);
      if (revision === "stale") return true;
      const incoming = (data.messages ?? []).filter((message) => !deleted.has(message.id));
      if (revision === "changed") {
        setReachedStart(false);
        stickToBottom.current = true;
      }
      setMessages((current) => mergeMessages(revision === "changed" ? [] : current, incoming));
      void ensureNames(senderIDs(incoming));
      return true;
    } catch { return false; }
    finally {
      pendingMessageReads.current.delete(deleted);
      setLoaded(true);
    }
  }, [room.id, ensureNames, acceptRevision]);

  // A send can finish after this room has been closed and reopened. Refresh
  // the currently mounted view, which also owns its pending history reads.
  useEffect(() => {
    if (lastSentCount.current === sentCount) return;
    lastSentCount.current = sentCount;
    stickToBottom.current = true;
    void poll();
  }, [sentCount, poll]);

  useEffect(() => {
    let active = true;
    let retryDelay = POLL_MS;
    let timer: number;
    const pollBackground = async () => {
      const succeeded = await poll();
      if (!active) return;
      const delay = succeeded ? POLL_MS : retryDelay;
      retryDelay = succeeded ? POLL_MS : Math.min(delay * 2, MAX_POLL_RETRY_MS);
      timer = window.setTimeout(() => void pollBackground(), delay);
    };
    void pollBackground();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [poll]);

  useEffect(() => () => {
    fileLookup.current = { pending: false, retryAt: 0, delay: POLL_MS, missing: new Set() };
  }, [room.id]);

  useEffect(() => {
    const lookup = fileLookup.current;
    if (lookup.pending) return;
    const needed = new Set<string>();
    for (const message of messages) for (const id of parseAttachments(message.attachments)) if (!files[id]) needed.add(id);
    if (needed.size === 0) return;
    if (Date.now() < lookup.retryAt && [...needed].every((id) => lookup.missing.has(id))) return;
    lookup.pending = true;
    void (async () => {
      try {
        const data = await bridge<{ files: FileRecord[] }>("files.list", { room_id: room.id });
        if (fileLookup.current !== lookup) return;
        const incoming = data.files ?? [];
        setFiles((current) => indexMissingFiles(current, incoming));
        if (incoming.some((file) => needed.has(file.id))) {
          lookup.delay = POLL_MS;
          lookup.retryAt = 0;
          return;
        }
      } catch { /* attachments render as generic chips until this succeeds */ }
      finally { lookup.pending = false; }
      // Retry on an existing message poll; a missing file creates no timer of its own.
      lookup.missing = needed;
      lookup.retryAt = Date.now() + lookup.delay;
      lookup.delay = Math.min(lookup.delay * 2, MAX_POLL_RETRY_MS);
    })();
  }, [messages, files, room.id]);

  async function download(fileID: string, filename: string) {
    setDownloading(fileID);
    try {
      const result = await bridge<{ saved_path: string }>("files.download", { room_id: room.id, file_id: fileID, filename });
      onNotice(`已保存到 ${result.saved_path}`);
    } catch (e) { onError(String(e)); } finally { setDownloading(""); }
  }

  useEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [messages]);

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  }

  async function loadOlder() {
    if (messages.length === 0 || loadingOlder) return;
    const boundary = messages[0];
    const readEpoch = revisionState.current.epoch;
    setLoadingOlder(true);
    const deleted = new Set<string>();
    pendingMessageReads.current.add(deleted);
    try {
      const data = await bridge<MessagePage>("messages.list", {
        room_id: room.id, before: boundary.id, before_created_at: boundary.created_at, limit: PAGE_SIZE,
      });
      const revision = acceptRevision(data.deletion_revision, readEpoch);
      if (revision === "stale") return;
      if (revision === "changed") {
        // The deletion may be in any cached page, not just this response.
        setMessages([]);
        setReachedStart(false);
        stickToBottom.current = true;
        await poll();
        return;
      }
      if ((data.messages ?? []).length === 0) setReachedStart(true);
      const older = (data.messages ?? []).filter((message) => !deleted.has(message.id));
      setMessages((current) => mergeMessages(current, older));
      void ensureNames(senderIDs(older));
    } catch (e) { onError(String(e)); } finally {
      pendingMessageReads.current.delete(deleted);
      setLoadingOlder(false);
    }
  }

  async function send() {
    const content = draft.trim();
    if (!content) return;
    const attempt = composer.begin("send");
    if (!attempt) return;
    try {
      await bridge("messages.send", { room_id: room.id, content });
      composer.sent(attempt.revision);
    } catch (e) { onError(String(e)); } finally { composer.finish(); }
  }

  async function attach() {
    const attempt = composer.begin("upload");
    if (!attempt) return;
    try {
      const path = await open({ multiple: false, directory: false });
      if (!path) return;
      const uploaded = await bridge<{ file_id: string; filename: string }>("files.upload", { room_id: room.id, path });
      // The message carries the attachment; content is optional (a bare caption).
      await bridge("messages.send", { room_id: room.id, content: draft.trim(), attachments: [uploaded.file_id] });
      composer.sent(attempt.revision);
      onNotice(`已发送附件 ${uploaded.filename}`);
    } catch (e) { onError(String(e)); } finally { composer.finish(); }
  }

  async function remove(message: Message) {
    const ok = await dialog.confirm({ title: "删除这条消息？", message: message.content.slice(0, 120), confirmLabel: "删除", danger: true });
    if (!ok) return;
    try {
      await bridge("messages.delete", { room_id: room.id, message_id: message.id });
      for (const deleted of pendingMessageReads.current) deleted.add(message.id);
      setMessages((current) => current.filter((m) => m.id !== message.id));
    } catch (e) { onError(String(e)); }
  }

  function openMessageMenu(e: React.MouseEvent, message: Message) {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: "复制文本", onSelect: () => onCopy(message.content, "消息") },
      { label: "复制消息 ID", onSelect: () => onCopy(message.id, "消息 ID") },
    ];
    if (message.user_id === myUserID || canModerate) items.push({ label: "删除消息", danger: true, onSelect: () => void remove(message) });
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  if (!loaded) return <div className="flex min-h-0 flex-1 flex-col"><ChatSkeleton /><div className="h-20 shrink-0 border-t border-base-300 bg-base-100" /></div>;

  return <div className="flex min-h-0 flex-1 flex-col bg-base-200">
    <div className="message-list" ref={listRef} onScroll={onScroll}>
      {!reachedStart && messages.length >= PAGE_SIZE && (
        <div className="mb-5 flex justify-center"><button className="btn btn-ghost btn-sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
          {loadingOlder && <Spinner />}加载更早的消息
        </button></div>
      )}
      {messages.length === 0 && <div className="h-full"><EmptyState icon="#" title="暂无消息" /></div>}
      {messages.map((message, index) => <Fragment key={message.id}>
        {(index === 0 || new Date(messages[index - 1].created_at * 1000).toDateString() !== new Date(message.created_at * 1000).toDateString()) &&
          <div className="day-rule">{new Date(message.created_at * 1000).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</div>}
        <article className="message-row" onContextMenu={(e) => openMessageMenu(e, message)}>
          <div className="message-avatar"><InitialAvatar name={getName(message.user_id)} /></div>
          <header className="message-author mb-1 flex items-center gap-2 text-xs text-base-content/55">
              <strong className="text-sm text-base-content">{getName(message.user_id)}</strong>
              <time dateTime={new Date(message.created_at * 1000).toISOString()}>{formatTime(message.created_at)}</time>
              {(message.user_id === myUserID || canModerate) && (
                <Tooltip label="删除消息"><button aria-label="删除消息" className="btn btn-ghost btn-circle btn-xs text-error" onClick={() => void remove(message)}>×</button></Tooltip>
              )}
          </header>
          <div className="message-body">
            {message.content && <p>{message.content}</p>}
            {parseAttachments(message.attachments).map((fileID) => {
              const file = files[fileID];
              return <Tooltip key={fileID} label={file ? file.mime_type : "下载附件"} className="mt-2 block">
                <button className="card card-border w-full max-w-80 bg-base-200 text-left text-base-content transition hover:bg-base-300" disabled={downloading === fileID}
                  onClick={() => void download(fileID, file?.filename ?? fileID)}>
                  <span className="card-body flex-row items-center gap-3 p-3">
                    <Icon name="attach" />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm">{file?.filename ?? "下载附件"}</strong>
                      {file && <small className="block text-xs text-base-content/50">{formatBytes(file.size_bytes)}</small>}
                    </span>
                    {downloading === fileID && <Spinner />}
                  </span>
                </button>
              </Tooltip>;
            })}
          </div>
        </article>
      </Fragment>)}
    </div>
    <form className="message-composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <IconButton label="上传附件" className="btn-md" disabled={uploading || sending} onClick={() => void attach()}>
        {uploading ? <Spinner /> : <Icon name="plus" />}
      </IconButton>
      <textarea aria-label={`发送到 #${room.name}`} rows={1} value={draft}
        onChange={(e) => composer.edit(e.target.value)}
        onKeyDown={(e) => {
          if (!shouldSendMessage(e.nativeEvent)) return;
          e.preventDefault();
          if (!e.repeat) void send();
        }}
        title="Enter 发送，Shift+Enter 换行" placeholder={uploading ? "上传中…" : `发送到 #${room.name}`} maxLength={4000} disabled={uploading} />
      <button className="send-message" type="submit" title="发送" aria-label="发送" disabled={sending || uploading || !draft.trim()}>
        {sending ? <Spinner /> : <Icon name="send" />}
      </button>
    </form>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
  </div>;
}
