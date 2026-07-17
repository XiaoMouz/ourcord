import { useCallback, useEffect, useRef, useState } from "react";
import { bridge, type Message, type Room } from "../bridge";
import { mergeMessages, senderIDs } from "../messages";
import { ChatSkeleton } from "./Skeleton";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { useDialog } from "../dialog";

const PAGE_SIZE = 50;
const POLL_MS = 3000;

function formatTime(createdAt: number): string {
  const date = new Date(createdAt * 1000);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString()} ${time}`;
}

export default function ChatPane({ room, myUserID, canModerate, getName, ensureNames, onError, onCopy }: {
  room: Room;
  myUserID: string;
  canModerate: boolean;
  getName: (userID: string) => string;
  ensureNames: (userIDs: string[]) => Promise<void>;
  onError: (message: string) => void;
  onCopy: (text: string, label: string) => void;
}) {
  const dialog = useDialog();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedStart, setReachedStart] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const poll = useCallback(async () => {
    try {
      const data = await bridge<{ messages: Message[] }>("messages.list", { room_id: room.id, limit: PAGE_SIZE });
      const incoming = data.messages ?? [];
      setMessages((current) => mergeMessages(current, incoming));
      void ensureNames(senderIDs(incoming));
    } catch { /* transient poll failure; the next tick retries */ }
    finally { setLoaded(true); }
  }, [room.id, ensureNames]);

  useEffect(() => {
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

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
    setLoadingOlder(true);
    try {
      const data = await bridge<{ messages: Message[] }>("messages.list", { room_id: room.id, before: messages[0].id, limit: PAGE_SIZE });
      const older = data.messages ?? [];
      if (older.length === 0) setReachedStart(true);
      setMessages((current) => mergeMessages(current, older));
      void ensureNames(senderIDs(older));
    } catch (e) { onError(String(e)); } finally { setLoadingOlder(false); }
  }

  async function send() {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await bridge("messages.send", { room_id: room.id, content });
      setDraft("");
      stickToBottom.current = true;
      await poll();
    } catch (e) { onError(String(e)); } finally { setSending(false); }
  }

  async function remove(message: Message) {
    const ok = await dialog.confirm({ title: "删除这条消息？", message: message.content.slice(0, 120), confirmLabel: "删除", danger: true });
    if (!ok) return;
    try {
      await bridge("messages.delete", { room_id: room.id, message_id: message.id });
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

  if (!loaded) return <div className="chat-pane"><ChatSkeleton /><div className="chat-composer" /></div>;

  return <div className="chat-pane">
    <div className="chat-scroll" ref={listRef} onScroll={onScroll}>
      {!reachedStart && messages.length >= PAGE_SIZE && (
        <button className="chat-older" disabled={loadingOlder} onClick={() => void loadOlder()}>
          {loadingOlder ? "加载中…" : "加载更早的消息"}
        </button>
      )}
      {messages.length === 0 && <p className="empty">还没有消息，来说点什么吧。</p>}
      {messages.map((message) => <article key={message.id} className="chat-message" onContextMenu={(e) => openMessageMenu(e, message)}>
        <div className="chat-avatar">{getName(message.user_id).slice(0, 1).toUpperCase()}</div>
        <div className="chat-body">
          <header>
            <strong>{getName(message.user_id)}</strong>
            <time>{formatTime(message.created_at)}</time>
            {(message.user_id === myUserID || canModerate) && (
              <button className="chat-delete" title="删除消息" onClick={() => void remove(message)}>×</button>
            )}
          </header>
          <p>{message.content}</p>
        </div>
      </article>)}
    </div>
    <form className="chat-composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`发送到 #${room.name}`} maxLength={4000} />
      <button type="submit" disabled={sending || !draft.trim()}>发送</button>
    </form>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
  </div>;
}
