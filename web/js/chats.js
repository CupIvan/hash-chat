import { isChatId } from "./util.js";

const CHATS_KEY = "hash-chat.chats";

export function loadChats() {
  let parsed;
  try {
    parsed = JSON.parse(localStorage.getItem(CHATS_KEY) || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => (typeof item === "string" ? { id: item } : item))
    .filter((chat) => chat && isChatId(chat.id))
    .map((chat) => ({
      id: chat.id,
      name: typeof chat.name === "string" ? chat.name : "",
      server: typeof chat.server === "string" ? chat.server : "",
      cas: typeof chat.cas === "string" ? chat.cas : "",
      lastTs: Number(chat.lastTs) || 0,
    }));
}

export function saveChats(chats) {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
  } catch {
    /* переполнение localStorage — не повод ломать чат */
  }
}

export function upsertChat(chats, chat) {
  const index = chats.findIndex((item) => item.id === chat.id);
  if (index === -1) {
    chats.unshift({ ...chat });
  } else {
    chats[index] = { ...chats[index], ...chat };
  }
  saveChats(chats);
  return chats;
}

export function touchChat(chats, id, ts) {
  const chat = chats.find((item) => item.id === id);
  if (!chat || !ts || ts <= (chat.lastTs || 0)) return false;
  chat.lastTs = ts;
  saveChats(chats);
  return true;
}
