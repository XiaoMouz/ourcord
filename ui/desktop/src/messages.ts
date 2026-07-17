import type { Message } from "./bridge";

// mergeMessages unions two message pages by id, in chronological order.
// Poll results replace nothing — existing entries win on id collision so the
// UI keeps stable object identities between polls.
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byID = new Map<string, Message>();
  for (const message of existing) byID.set(message.id, message);
  for (const message of incoming) {
    if (!byID.has(message.id)) byID.set(message.id, message);
  }
  return [...byID.values()].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// senderIDs collects the distinct user ids referenced by a message page, in
// first-seen order, for display-name lookups.
export function senderIDs(messages: Message[]): string[] {
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.user_id) seen.add(message.user_id);
  }
  return [...seen];
}
