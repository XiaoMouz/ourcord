import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { bridge, type FileRecord, type Message, type Room } from "../bridge";
import { mergeMessages, senderIDs } from "../messages";
import { shouldSendMessage } from "../composer";
import { formatBytes, parseAttachments } from "../format";
import { ChatSkeleton, Spinner } from "./Skeleton";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { useDialog } from "../dialog";
import { EmptyState, IconButton, InitialAvatar, Tooltip, cx } from "./ui";

const PAGE_SIZE = 50;
const POLL_MS = 3000;

function formatTime(createdAt: number): string {
  const date = new Date(createdAt * 1000);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString()} ${time}`;
}

export default function ChatPane({ room, myUserID, canModerate, getName, ensureNames, onError, onCopy, onNotice }: {
  room: Room;
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
  const [draft, setDraft] = useState("");
  const draftRevision = useRef(0);
  const composerBusy = useRef(false);
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedStart, setReachedStart] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [files, setFiles] = useState<Record<string, FileRecord>>({});
  const [downloading, setDownloading] = useState("");
  const [uploading, setUploading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // Track deletions only for reads already in flight; each read releases its
  // exclusions on completion instead of retaining an ever-growing tombstone set.
  const pendingMessageReads = useRef(new Set<Set<string>>());

  const poll = useCallback(async () => {
    const deleted = new Set<string>();
    pendingMessageReads.current.add(deleted);
    try {
      const data = await bridge<{ messages: Message[] }>("messages.list", { room_id: room.id, limit: PAGE_SIZE });
      const incoming = (data.messages ?? []).filter((message) => !deleted.has(message.id));
      setMessages((current) => mergeMessages(current, incoming));
      void ensureNames(senderIDs(incoming));
    } catch { /* transient poll failure; the next tick retries */ }
    finally {
      pendingMessageReads.current.delete(deleted);
      setLoaded(true);
    }
  }, [room.id, ensureNames]);

  useEffect(() => {
    let polling = false;
    const pollBackground = async () => {
      if (polling) return;
      polling = true;
      try { await poll(); }
      finally { polling = false; }
    };
    void pollBackground();
    const timer = window.setInterval(() => void pollBackground(), POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  // Resolve attachment ids to file metadata lazily: only hit files.list when a
  // message references an id we have not indexed yet.
  useEffect(() => {
    const needed = new Set<string>();
    for (const message of messages) for (const id of parseAttachments(message.attachments)) if (!files[id]) needed.add(id);
    if (needed.size === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await bridge<{ files: FileRecord[] }>("files.list", { room_id: room.id });
        if (cancelled) return;
        setFiles((current) => {
          const next = { ...current };
          for (const file of data.files ?? []) next[file.id] = file;
          return next;
        });
      } catch { /* attachments render as generic chips until this succeeds */ }
    })();
    return () => { cancelled = true; };
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
    setLoadingOlder(true);
    const deleted = new Set<string>();
    pendingMessageReads.current.add(deleted);
    try {
      const data = await bridge<{ messages: Message[] }>("messages.list", {
        room_id: room.id, before: boundary.id, before_created_at: boundary.created_at, limit: PAGE_SIZE,
      });
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
    if (!content || composerBusy.current) return;
    composerBusy.current = true;
    const submittedRevision = draftRevision.current;
    setSending(true);
    try {
      await bridge("messages.send", { room_id: room.id, content });
      if (draftRevision.current === submittedRevision) setDraft("");
      stickToBottom.current = true;
      await poll();
    } catch (e) { onError(String(e)); } finally { composerBusy.current = false; setSending(false); }
  }

  async function attach() {
    if (composerBusy.current) return;
    composerBusy.current = true;
    const submittedRevision = draftRevision.current;
    setUploading(true);
    try {
      const path = (await open({ multiple: false, directory: false })) as string | null;
      if (!path) return;
      const uploaded = await bridge<{ file_id: string; filename: string }>("files.upload", { room_id: room.id, path });
      // The message carries the attachment; content is optional (a bare caption).
      await bridge("messages.send", { room_id: room.id, content: draft.trim(), attachments: [uploaded.file_id] });
      if (draftRevision.current === submittedRevision) setDraft("");
      stickToBottom.current = true;
      await poll();
      onNotice(`已发送附件 ${uploaded.filename}`);
    } catch (e) { onError(String(e)); } finally { composerBusy.current = false; setUploading(false); }
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
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" ref={listRef} onScroll={onScroll}>
      {!reachedStart && messages.length >= PAGE_SIZE && (
        <div className="mb-5 flex justify-center"><button className="btn btn-ghost btn-sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
          {loadingOlder && <Spinner />}加载更早的消息
        </button></div>
      )}
      {messages.length === 0 && <div className="h-full"><EmptyState icon="#" title="暂无消息" /></div>}
      {messages.map((message) => <article key={message.id} className={cx("chat", message.user_id === myUserID ? "chat-end" : "chat-start")} onContextMenu={(e) => openMessageMenu(e, message)}>
        <div className="chat-image"><InitialAvatar name={getName(message.user_id)} size="sm" /></div>
        <header className="chat-header mb-1 flex items-center gap-2 text-xs text-base-content/55">
            <strong className="text-sm text-base-content">{getName(message.user_id)}</strong>
            <time>{formatTime(message.created_at)}</time>
            {(message.user_id === myUserID || canModerate) && (
              <Tooltip label="删除消息"><button className="btn btn-ghost btn-circle btn-xs text-error" onClick={() => void remove(message)}>×</button></Tooltip>
            )}
        </header>
        <div className={cx("chat-bubble max-w-xl whitespace-pre-wrap break-words", message.user_id === myUserID ? "chat-bubble-primary" : "bg-base-100 text-base-content")}>
          {message.content && <p>{message.content}</p>}
          {parseAttachments(message.attachments).map((fileID) => {
            const file = files[fileID];
            return <Tooltip key={fileID} label={file ? file.mime_type : "下载附件"} className="mt-2 block">
              <button className="card card-border w-full min-w-64 bg-base-200 text-left text-base-content transition hover:bg-base-300" disabled={downloading === fileID}
                onClick={() => void download(fileID, file?.filename ?? fileID)}>
                <span className="card-body flex-row items-center gap-3 p-3">
                  <span className="text-lg">📎</span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm">{file?.filename ?? "附件"}</strong>
                    <small className="block text-xs text-base-content/50">{file ? formatBytes(file.size_bytes) : "点击下载"}</small>
                  </span>
                  {downloading === fileID && <Spinner />}
                </span>
              </button>
            </Tooltip>;
          })}
        </div>
      </article>)}
    </div>
    <form className="flex shrink-0 items-center gap-2 border-t border-base-300 bg-base-100 p-4" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <IconButton label="上传附件" className="btn-md" disabled={uploading || sending} onClick={() => void attach()}>
        {uploading ? <Spinner /> : "＋"}
      </IconButton>
      <textarea className="textarea min-h-12 max-h-40 min-w-0 flex-1 resize-y" rows={2} value={draft}
        onChange={(e) => { draftRevision.current += 1; setDraft(e.target.value); }}
        onKeyDown={(e) => { if (shouldSendMessage(e.nativeEvent)) { e.preventDefault(); void send(); } }}
        aria-label={`发送到 #${room.name}`} title="Enter 发送，Shift+Enter 换行"
        placeholder={uploading ? "上传中…" : `发送到 #${room.name}（Shift+Enter 换行）`} maxLength={4000} disabled={uploading} />
      <button className="btn btn-primary" type="submit" disabled={sending || uploading || !draft.trim()}>
        {sending && <Spinner />}发送
      </button>
    </form>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
  </div>;
}
