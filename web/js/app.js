import { HashClient, MissingError, canonicalJSON, sha256Hex } from "../hash.js";
import { Api, ApiError } from "./api.js";
import {
  clearNameCache,
  clearProfile,
  deviceHashFor,
  loadProfile,
  makeProfile,
  profileLabel,
  resolveName,
  saveProfileLocal,
} from "./identity.js";
import {
  endpointsForChat,
  hasEndpoints,
  loadEndpoints,
  saveEndpoints,
} from "./config.js";
import { loadChats, touchChat, upsertChat } from "./chats.js";
import {
  byId,
  closeModal,
  focusInput,
  hideReplyBar,
  isNearBottom,
  openModal,
  refs,
  renderChatList,
  scrollFeedBottom,
  setChatHeader,
  setComposerState,
  setFormError,
  setScreen,
  setWarning,
  showReplyBar,
  toast,
  updateProfileButton,
} from "./ui.js";
import {
  copyText,
  decodeBase64Url,
  encodeBase64Url,
  fmtDateTime,
  fmtTime,
  h,
  isChatId,
  isHex64,
  normalizeBase,
  parseBase,
  sleep,
  truncate,
} from "./util.js";

const FEED_LIMIT = 100;

const apiClients = new Map();
const casClients = new Map();

const state = {
  endpoints: loadEndpoints(),
  profile: loadProfile(),
  chats: loadChats(),
  active: null,
  entries: [],
  msgs: new Map(),
  dels: new Map(),
  reply: null,
  total: 0,
  nextBefore: 0,
  loadingMore: false,
  ready: false,
  poll: 0,
  abort: null,
  pendingInvite: null,
};

/* --- клиенты --- */

function apiFor(url) {
  const base = normalizeBase(url);
  if (!base) return null;
  if (!apiClients.has(base)) apiClients.set(base, new Api(base));
  return apiClients.get(base);
}

function casFor(url) {
  const base = normalizeBase(url);
  if (!base) return null;
  if (!casClients.has(base)) casClients.set(base, new HashClient({ endpoint: base }));
  return casClients.get(base);
}

/* --- маршрутизация --- */

function route() {
  closeModal();
  const hash = location.hash.replace(/^#/, "") || "/";
  if (hash.startsWith("/chat/")) {
    const raw = hash.slice("/chat/".length).split("?")[0];
    let id = raw;
    try {
      id = decodeURIComponent(raw);
    } catch {
      /* оставим как есть */
    }
    openChat(id);
    return;
  }
  if (hash.startsWith("/invite/")) {
    openInvite(hash.slice("/invite/".length));
    return;
  }
  showWelcome();
}

function navigate(path) {
  const target = "#" + (path.startsWith("/") ? path : "/" + path);
  if (location.hash === target) route();
  else location.hash = target;
}

function showWelcome() {
  leaveChat();
  setScreen("welcome");
  document.title = "hash-chat";
  refreshChrome();
}

function leaveChat() {
  if (state.abort) {
    state.abort.abort();
    state.abort = null;
  }
  state.poll++;
  state.active = null;
  state.entries = [];
  state.msgs = new Map();
  state.dels = new Map();
  state.reply = null;
  state.total = 0;
  state.nextBefore = 0;
  state.loadingMore = false;
  state.ready = false;
  refs.feed.textContent = "";
  refs.input.value = "";
  autoGrow();
  hideReplyBar();
  setWarning("");
}

/* --- открытие чата --- */

async function openChat(id) {
  if (!isChatId(id)) {
    toast("Неверный id чата");
    navigate("/");
    return;
  }

  const chat = state.chats.find((item) => item.id === id) || {
    id,
    name: "",
    server: "",
    cas: "",
    lastTs: 0,
  };
  const endpoints = endpointsForChat(chat, state.endpoints);
  if (!endpoints.api || !endpoints.cas) {
    openSetup({ force: true });
    toast("Сначала настройте API и CAS");
    return;
  }

  const api = apiFor(endpoints.api);
  const cas = casFor(endpoints.cas);
  if (!api || !cas) {
    toast("Неверные адреса подключения");
    openSetup({ force: true });
    return;
  }

  leaveChat();
  state.active = { id, chat, api, cas, apiUrl: endpoints.api, casUrl: endpoints.cas };
  if (state.profile) publishProfile({ api: endpoints.api, cas: endpoints.cas });

  setScreen("chat");
  setComposerState(state.profile);
  setChatHeader(chat, 0);
  refreshChrome();
  refs.feed.append(h("div", { class: "feed-note", text: "Загружаю ленту…" }));

  await loadInitial();
}

/* --- лента --- */

async function loadInitial() {
  const active = state.active;
  if (!active) return;

  // Перечитывание (например, после 409) не должно пересекаться с поллером.
  state.abort?.abort();
  state.abort = null;
  state.poll++;
  state.ready = false;

  refs.feed.textContent = "";
  refs.feed.append(h("div", { class: "feed-note", text: "Загружаю ленту…" }));

  let body;
  try {
    body = await active.api.feed(active.id, { limit: FEED_LIMIT });
  } catch (err) {
    if (state.active !== active) return;
    refs.feed.textContent = "";
    refs.feed.append(
      h("div", { class: "feed-note", text: "Не удалось загрузить ленту: " + errorText(err) }),
    );
    setWarning("Сервер недоступен");
    startPoll();
    state.ready = true;
    return;
  }
  if (state.active !== active) return;

  const data = body || {};
  state.entries = Array.isArray(data.entries) ? data.entries : [];
  state.total = Number(data.total) || 0;
  state.nextBefore = Number(data.next_before) || 0;

  const messages = await loadMessages(active.cas, state.entries);
  if (state.active !== active) return;
  state.msgs = messages;

  applyDelOps(true);
  renderAll({ scrollBottom: true });

  const maxTs = state.entries.reduce((max, entry) => Math.max(max, Number(entry.ts) || 0), 0);
  if (maxTs && touchChat(state.chats, active.id, maxTs)) refreshChrome();

  startPoll();
  requestAnimationFrame(() => {
    state.ready = true;
  });
}

async function loadMessages(cas, entries) {
  if (!entries.length) return new Map();
  try {
    return await cas.getMany(entries.map((entry) => entry.hash));
  } catch (err) {
    toast("CAS недоступен: " + errorText(err));
    return new Map();
  }
}

function renderAll({ scrollBottom = false } = {}) {
  const oldHeight = refs.feed.scrollHeight;
  const oldTop = refs.feed.scrollTop;

  refs.feed.textContent = "";
  if (state.nextBefore) refs.feed.append(loadMoreButton());

  const hasVisible = state.entries.some((entry) => {
    const msg = state.msgs.get(entry.hash);
    return !(msg && msg.del);
  });

  if (!hasVisible) {
    refs.feed.append(
      h("div", {
        class: "feed-note",
        text: state.total
          ? "Сообщения не загрузились — возможно, CAS недоступен"
          : "Сообщений пока нет — напишите первым.",
      }),
    );
  } else {
    for (const entry of state.entries) {
      const msg = state.msgs.get(entry.hash);
      if (msg && msg.del) continue;
      refs.feed.append(messageNode(entry, msg));
    }
  }

  verifyChain();
  updateHeader();

  if (scrollBottom) scrollFeedBottom();
  else if (oldHeight) refs.feed.scrollTop = oldTop + (refs.feed.scrollHeight - oldHeight);
}

function loadMoreButton() {
  return h("button", {
    class: "load-more",
    type: "button",
    text: "Загрузить ещё",
    onclick: () => loadMore(),
  });
}

async function loadMore() {
  const active = state.active;
  if (!active || !state.nextBefore || state.loadingMore) return;

  state.loadingMore = true;
  state.ready = false;
  try {
    const body = await active.api.feed(active.id, {
      before: state.nextBefore,
      limit: FEED_LIMIT,
    });
    if (state.active !== active) return;
    const data = body || {};
    const older = Array.isArray(data.entries) ? data.entries : [];
    const messages = await loadMessages(active.cas, older);
    if (state.active !== active) return;

    for (const [hash, msg] of messages) state.msgs.set(hash, msg);
    const known = new Set(state.entries.map((entry) => entry.hash));
    state.entries = [...older.filter((entry) => !known.has(entry.hash)), ...state.entries];
    state.nextBefore = Number(data.next_before) || 0;
    state.total = Number(data.total) || state.total;

    applyDelOps(true);
    renderAll();
  } catch (err) {
    toast("Не загрузилось: " + errorText(err));
  } finally {
    state.loadingMore = false;
    if (state.active === active) {
      requestAnimationFrame(() => {
        state.ready = true;
      });
    }
  }
}

function startPoll() {
  const active = state.active;
  if (!active) return;

  state.abort?.abort();
  const controller = new AbortController();
  state.abort = controller;
  const token = ++state.poll;
  pollLoop(active, token, controller.signal);
}

async function pollLoop(active, token, signal) {
  while (token === state.poll && state.active === active) {
    try {
      const res = await active.api.head(active.id, lastSeq(), 25, signal);
      if (token !== state.poll || state.active !== active) return;
      if (res && res.head) {
        await pullFrom(active, token, res.head, Number(res.seq) || lastSeq());
      } else {
        await sleep(900);
      }
    } catch (err) {
      if (signal.aborted) return;
      await sleep(2500);
    }
  }
}

async function pullFrom(active, token, head, headSeq) {
  if (state.active !== active || token !== state.poll) return;
  if (state.entries.some((entry) => entry.hash === head)) return;

  const known = new Set(state.entries.map((entry) => entry.hash));
  const chain = [];
  let cursor = head;
  while (cursor && !known.has(cursor)) {
    const msg = await active.cas.get(cursor);
    chain.push({ hash: cursor, msg });
    cursor = typeof msg.prev === "string" ? msg.prev : "";
    if (chain.length > 5000) throw new Error("слишком длинная цепочка");
    if (state.active !== active || token !== state.poll) return;
  }

  chain.reverse();
  let seq = Number(headSeq) - chain.length + 1;
  if (!Number.isFinite(seq) || seq < 1) seq = 1;

  const wasAtBottom = isNearBottom();
  for (const item of chain) {
    if (state.active !== active || token !== state.poll) return;
    addIncoming(
      { seq: seq++, hash: item.hash, prev: item.msg.prev || "", ts: item.msg.ts },
      item.msg,
    );
  }

  verifyChain();
  updateHeader();
  if (wasAtBottom) scrollFeedBottom();
}

function addIncoming(entry, msg) {
  if (!state.active) return;
  if (state.entries.some((item) => item.hash === entry.hash)) return;

  const atBottom = isNearBottom();
  state.entries.push(entry);
  state.msgs.set(entry.hash, msg);
  state.total += 1;

  if (msg.del) {
    recordDel(msg);
  } else {
    removeFeedNotes();
    refs.feed.append(messageNode(entry, msg));
    if (atBottom) scrollFeedBottom();
  }

  if (entry.ts && touchChat(state.chats, state.active.id, entry.ts)) refreshChrome();
  verifyChain();
  updateHeader();
}

function removeFeedNotes() {
  for (const note of refs.feed.querySelectorAll(".feed-note")) note.remove();
}

function lastSeq() {
  return state.entries.length ? state.entries[state.entries.length - 1].seq : 0;
}

/* --- цепочка и удаления --- */

function verifyChain() {
  let broken = false;
  for (let i = 1; i < state.entries.length; i++) {
    const previous = state.entries[i - 1].hash;
    const msg = state.msgs.get(state.entries[i].hash);
    if (msg && typeof msg.prev === "string" && msg.prev !== previous) {
      broken = true;
      break;
    }
  }
  setWarning(broken ? "Цепочка сообщений не сходится с лентой сервера" : "");
}

function isDeleted(hash, msg) {
  if (!msg) return false;
  const authors = state.dels.get(hash);
  return Boolean(authors && authors.has(msg.author));
}

function applyDelOps(silent = false) {
  for (const entry of state.entries) {
    const msg = state.msgs.get(entry.hash);
    if (msg && typeof msg.del === "string") recordDel(msg, silent);
  }
}

function recordDel(msg, silent = false) {
  if (!msg || !isHex64(msg.del) || !isHex64(msg.author)) return;
  let authors = state.dels.get(msg.del);
  if (!authors) {
    authors = new Set();
    state.dels.set(msg.del, authors);
  }
  if (authors.has(msg.author)) return;
  authors.add(msg.author);
  if (!silent) refreshMessage(msg.del);
}

function refreshMessage(hash) {
  const old = document.getElementById("m-" + hash);
  const entry = state.entries.find((item) => item.hash === hash);
  const msg = state.msgs.get(hash);
  if (!old || !entry || !msg) return;
  old.replaceWith(messageNode(entry, msg));
}

/* --- отрисовка сообщений --- */

function messageNode(entry, msg) {
  const hash = entry.hash;

  if (!msg) {
    return h("div", { class: "msg pending", id: "m-" + hash }, [
      h("div", { class: "msg-meta" }, [
        h("span", { class: "msg-author", text: "…" }),
        h("time", { class: "msg-time", text: fmtTime(entry.ts) }),
      ]),
      h("div", { class: "msg-text", text: "сообщение не загрузилось" }),
    ]);
  }

  const own = Boolean(state.profile?.deviceHash && msg.author === state.profile.deviceHash);
  const deleted = isDeleted(hash, msg);
  const node = h("div", {
    class: "msg" + (own ? " own" : "") + (deleted ? " deleted" : ""),
    id: "m-" + hash,
    dataset: { hash },
  });

  const author = h("span", {
    class: "msg-author",
    text: own
      ? profileLabel(state.profile) + " (вы)"
      : "#" + (isHex64(msg.author) ? msg.author.slice(0, 8) : "anon"),
  });
  const time = h("time", {
    class: "msg-time",
    datetime: new Date(msg.ts).toISOString(),
    title: new Date(msg.ts).toLocaleString("ru-RU"),
    text: fmtDateTime(msg.ts),
  });
  node.append(h("div", { class: "msg-meta" }, [author, time]));

  if (!own && isHex64(msg.author) && state.active) {
    const active = state.active;
    resolveName(active.api, active.cas, msg.author).then((name) => {
      if (name && node.isConnected && state.active === active) author.textContent = name;
    });
  }

  if (deleted) {
    node.append(h("div", { class: "msg-text", text: "сообщение удалено" }));
    return node;
  }

  if (typeof msg.reply === "string" && msg.reply) node.append(quoteNode(msg.reply));
  node.append(h("div", { class: "msg-text", text: String(msg.text ?? "") }));

  const actions = h("div", { class: "msg-actions" });
  actions.append(
    h("button", {
      class: "msg-action",
      type: "button",
      title: "Ответить",
      "aria-label": "Ответить",
      text: "↩",
      onclick: () => startReply(entry, msg),
    }),
  );
  if (own) {
    actions.append(
      h("button", {
        class: "msg-action",
        type: "button",
        title: "Удалить",
        "aria-label": "Удалить",
        text: "🗑",
        onclick: () => deleteMessage(entry, msg),
      }),
    );
  }
  node.append(actions);
  return node;
}

function quoteNode(targetHash) {
  const button = h("button", {
    class: "msg-quote",
    type: "button",
    text: "↩ сообщение",
    onclick: () => jumpTo(targetHash),
  });

  const cached = state.msgs.get(targetHash);
  if (cached) {
    setQuote(button, cached);
  } else if (state.active) {
    const active = state.active;
    active.cas
      .get(targetHash)
      .then((msg) => {
        if (state.active !== active) return;
        if (!state.msgs.has(targetHash)) state.msgs.set(targetHash, msg);
        if (button.isConnected) setQuote(button, msg);
      })
      .catch(() => {});
  }
  return button;
}

function setQuote(button, msg) {
  if (!msg || msg.del) {
    button.textContent = "↩ сообщение";
    return;
  }
  const text = truncate(msg.text || "сообщение", 70);
  button.textContent = "↩ " + text;
  button.title = text;
}

function jumpTo(hash) {
  const node = document.getElementById("m-" + hash);
  if (!node) {
    toast("Сообщение не загружено");
    return;
  }
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.classList.add("flash");
  setTimeout(() => node.classList.remove("flash"), 1200);
}

/* --- действия --- */

function startReply(entry, msg) {
  if (!state.active) return;
  state.reply = { hash: entry.hash, text: msg.text || "" };
  showReplyBar(state.reply.text, () => jumpTo(entry.hash));
  focusInput();
}

function clearReply() {
  state.reply = null;
  hideReplyBar();
}

async function deleteMessage(entry, msg) {
  if (!state.profile || msg.author !== state.profile.deviceHash) return;
  if (!confirm("Удалить сообщение?")) return;
  try {
    await postRecord({ del: entry.hash });
  } catch (err) {
    toast("Не удалилось: " + errorText(err));
  }
}

function tailHash() {
  return state.entries.length ? state.entries[state.entries.length - 1].hash : "";
}

function ensureChatSaved() {
  const active = state.active;
  if (!active || state.chats.some((chat) => chat.id === active.id)) return;
  const chat = {
    id: active.id,
    name: active.chat.name || "",
    server: active.chat.server || "",
    cas: active.chat.cas || "",
    lastTs: Date.now(),
  };
  upsertChat(state.chats, chat);
  active.chat = state.chats.find((item) => item.id === active.id) || chat;
  refreshChrome();
}

async function postRecord(fields, attempt = 0) {
  const active = state.active;
  if (!active) throw new Error("чат не открыт");
  if (!state.profile?.deviceHash) throw new Error("нужен профиль");

  ensureChatSaved();
  const prev = tailHash();
  const msg = { ts: Date.now(), author: state.profile.deviceHash, prev, ...fields };
  const hash = await active.cas.put(msg);

  try {
    const res = await active.api.post(active.id, { hash, prev, ts: msg.ts });
    if (state.active === active && res && res.entry) addIncoming(res.entry, msg);
    return res?.entry;
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.status === 409 &&
      attempt < 1 &&
      state.active === active
    ) {
      await loadInitial();
      if (state.active !== active) throw err;
      return postRecord(fields, attempt + 1);
    }
    throw err;
  }
}

async function send() {
  if (!state.active) return;
  if (!ensureProfile()) return;
  const text = refs.input.value.trim();
  if (!text) return;

  const reply = state.reply?.hash || "";
  refs.send.disabled = true;
  try {
    await postRecord(reply ? { text, reply } : { text });
    refs.input.value = "";
    autoGrow();
    clearReply();
    focusInput();
  } catch (err) {
    toast("Не отправлено: " + errorText(err));
  } finally {
    refs.send.disabled = false;
  }
}

function errorText(err) {
  if (err instanceof ApiError) {
    if (err.status === 0) return "сервер недоступен";
    if (err.code === "prev_mismatch") return "лента обновилась, попробуйте ещё раз";
    if (["bad_hash", "bad_prev", "bad_ts", "bad_chat_id"].includes(err.code)) {
      return "сервер отклонил запись";
    }
    return `ошибка ${err.status} (${err.code})`;
  }
  if (err instanceof MissingError) return "контент ещё не в CAS";
  if (err?.message) return err.message;
  return "неизвестная ошибка";
}

/* --- профиль и подключение --- */

function ensureProfile() {
  if (!state.profile?.deviceHash) {
    openProfile();
    toast("Войдите, чтобы писать");
    return false;
  }
  return true;
}

function publishProfile(endpoints = state.endpoints) {
  const profile = state.profile;
  if (!profile?.deviceHash) return;

  const api = apiFor(endpoints.api);
  const register = () => {
    if (api) api.registerId(profile.deviceHash, profile.hash).catch(() => {});
  };

  try {
    const cas = casFor(endpoints.cas);
    if (!cas) {
      register();
      return;
    }
    const payload = { ts: profile.ts, login: profile.login, name: profile.name };
    cas
      .put(payload)
      .then((hash) => cas.upload(hash))
      .then(register)
      .catch(register);
  } catch {
    register();
  }
}

function openProfile() {
  if (!hasEndpoints(state.endpoints)) {
    openSetup({ force: true });
    toast("Сначала настройте подключение");
    return;
  }
  const profile = state.profile;
  refs.profile.login.value = profile?.login || "";
  refs.profile.name.value = profile?.name || "";
  refs.profile.logout.hidden = !profile;
  setFormError(refs.profile.error, "");
  openModal("profile");
}

async function submitProfile(event) {
  event.preventDefault();
  const login = refs.profile.login.value.trim();
  const name = refs.profile.name.value.trim();
  if (!login) {
    setFormError(refs.profile.error, "Логин обязателен");
    return;
  }

  if (
    state.profile?.deviceHash &&
    state.profile.login === login &&
    state.profile.name === name
  ) {
    closeModal(true);
    return;
  }

  try {
    setFormError(refs.profile.error, "");
    const profile = await makeProfile(login, name);
    profile.deviceHash = await deviceHashFor(profile);
    saveProfileLocal(profile);
    state.profile = profile;
    publishProfile();
    if (state.active) {
      publishProfile({ api: state.active.apiUrl, cas: state.active.casUrl });
    }
    refreshChrome();
    setComposerState(state.profile);
    if (state.active) renderAll();
    closeModal(true);
    toast("Профиль сохранён");
  } catch (err) {
    setFormError(refs.profile.error, errorText(err));
  }
}

function logout() {
  clearProfile();
  state.profile = null;
  refreshChrome();
  setComposerState(null);
  if (state.active) renderAll();
  closeModal(true);
  toast("Вы вышли");
}

function openSetup({ force = false } = {}) {
  refs.setup.api.value = state.endpoints.api;
  refs.setup.cas.value = state.endpoints.cas;
  refs.setup.close.hidden = force;
  setFormError(refs.setup.error, "");
  openModal("setup", { closable: !force });
}

function submitSetup(event) {
  event.preventDefault();
  let api;
  let cas;
  try {
    api = parseBase(refs.setup.api.value);
    cas = parseBase(refs.setup.cas.value);
  } catch (err) {
    setFormError(refs.setup.error, err.message);
    return;
  }
  if (!api || !cas) {
    setFormError(refs.setup.error, "Укажите оба адреса");
    return;
  }

  try {
    state.endpoints = saveEndpoints({ api, cas });
  } catch (err) {
    setFormError(refs.setup.error, err.message);
    return;
  }

  clearNameCache();
  closeModal(true);
  toast("Подключение сохранено");
  publishProfile();
  refreshChrome();

  if (state.active) openChat(state.active.id);
  else route();
}

function openChatSettings() {
  const active = state.active;
  if (!active) return;
  refs.chatSettings.name.value = active.chat.name || "";
  refs.chatSettings.server.value = active.chat.server || "";
  refs.chatSettings.cas.value = active.chat.cas || "";
  refs.chatSettings.server.placeholder = state.endpoints.api || "как в подключении";
  refs.chatSettings.cas.placeholder = state.endpoints.cas || "как в подключении";
  setFormError(refs.chatSettings.error, "");
  openModal("chat");
}

function submitChatSettings(event) {
  event.preventDefault();
  const active = state.active;
  if (!active) return;

  let server;
  let cas;
  try {
    server = parseBase(refs.chatSettings.server.value);
    cas = parseBase(refs.chatSettings.cas.value);
  } catch (err) {
    setFormError(refs.chatSettings.error, err.message);
    return;
  }

  const oldServer = active.chat.server || "";
  const oldCas = active.chat.cas || "";
  const next = {
    ...active.chat,
    name: refs.chatSettings.name.value.trim(),
    server,
    cas,
  };
  upsertChat(state.chats, next);
  active.chat = state.chats.find((item) => item.id === active.id) || next;
  setChatHeader(active.chat, visibleTotal());
  refreshChrome();
  closeModal(true);

  if (server !== oldServer || cas !== oldCas) {
    clearNameCache();
    openChat(active.id);
  }
  else toast("Сохранено");
}

/* --- приглашения --- */

function makeInviteLink() {
  const active = state.active;
  if (!active) return "";
  const endpoints = endpointsForChat(active.chat, state.endpoints);
  const payload = { chat: active.id };
  if (state.profile?.hash) payload.user = state.profile.hash;
  if (endpoints.api) payload.server = endpoints.api;
  if (endpoints.cas) payload.cas = endpoints.cas;

  const code = encodeBase64Url(canonicalJSON(payload));
  const base =
    location.origin +
    location.pathname.replace(/index\.html$/, "").replace(/\/?$/, "/");
  return `${base}#/invite/${code}`;
}

function openInviteModal() {
  if (!state.active) return;
  refs.invite.link.value = makeInviteLink();
  refs.invite.hint.textContent = "";
  openModal("invite");
  refs.invite.link.select();
}

async function copyInvite() {
  const ok = await copyText(refs.invite.link.value);
  refs.invite.hint.textContent = ok
    ? "Скопировано"
    : "Не удалось скопировать — выделите ссылку вручную";
  if (ok) toast("Ссылка скопирована");
  else refs.invite.link.select();
}

function openInvite(code) {
  leaveChat();
  setScreen("invite");
  document.title = "Приглашение — hash-chat";

  let invite;
  try {
    invite = JSON.parse(decodeBase64Url(code));
  } catch {
    toast("Некорректная ссылка-приглашение");
    navigate("/");
    return;
  }

  if (!invite || !isChatId(invite.chat)) {
    toast("Некорректная ссылка-приглашение");
    navigate("/");
    return;
  }

  let server = "";
  let cas = "";
  try {
    server = parseBase(invite.server || "");
    cas = parseBase(invite.cas || "");
  } catch {
    toast("В приглашении неверные адреса");
    navigate("/");
    return;
  }

  state.pendingInvite = {
    chat: invite.chat,
    user: isHex64(invite.user) ? invite.user : "",
    server,
    cas,
  };

  const existing = state.chats.some((chat) => chat.id === invite.chat);
  refs.inviteId.textContent = invite.chat;
  refs.inviteText.textContent = existing
    ? "Этот чат уже есть в вашем списке."
    : "Вас приглашают в чат. Код содержит адрес чата и серверы.";
  byId("btn-join").textContent = existing ? "Открыть чат" : "Присоединиться";
  refreshChrome();
}

function joinInvite() {
  const invite = state.pendingInvite;
  if (!invite) {
    navigate("/");
    return;
  }

  if (state.chats.some((chat) => chat.id === invite.chat)) {
    navigate(`/chat/${invite.chat}`);
    return;
  }

  if (!state.endpoints.api && invite.server) state.endpoints.api = invite.server;
  if (!state.endpoints.cas && invite.cas) state.endpoints.cas = invite.cas;

  if (!hasEndpoints(state.endpoints)) {
    openSetup({ force: true });
    toast("Сначала настройте API и CAS");
    return;
  }

  try {
    saveEndpoints(state.endpoints);
  } catch {
    /* адреса уже нормализованы */
  }

  const chat = {
    id: invite.chat,
    name: "",
    server: invite.server || "",
    cas: invite.cas || "",
    lastTs: Date.now(),
  };
  upsertChat(state.chats, chat);
  publishProfile();
  state.pendingInvite = null;
  refreshChrome();
  toast("Чат добавлен");
  navigate(`/chat/${chat.id}`);
}

/* --- создание чата --- */

async function createChat() {
  if (!hasEndpoints(state.endpoints)) {
    openSetup({ force: true });
    toast("Сначала настройте подключение");
    return;
  }
  if (!ensureProfile()) return;

  try {
    const id = await sha256Hex(
      new TextEncoder().encode(
        canonicalJSON({ ts: Date.now(), deviceHash: state.profile.deviceHash }),
      ),
    );
    const chat = { id, name: "", server: "", cas: "", lastTs: Date.now() };
    upsertChat(state.chats, chat);
    refreshChrome();
    navigate(`/chat/${id}`);
    toast("Чат создан");
  } catch (err) {
    toast("Чат не создался: " + errorText(err));
  }
}

/* --- общий chrome --- */

function refreshChrome() {
  updateProfileButton(state.profile);
  renderChatList(state.chats, state.active?.id, (id) => navigate(`/chat/${id}`));

  byId("btn-welcome-profile").textContent = state.profile ? "Профиль" : "Войти";
  const hint = byId("welcome-hint");
  if (!hasEndpoints(state.endpoints)) hint.textContent = "Сначала настройте подключение.";
  else if (!state.profile) hint.textContent = "Войдите, чтобы создавать чаты и писать.";
  else hint.textContent = "Создайте чат или откройте ссылку-приглашение.";
}

function visibleTotal() {
  let count = 0;
  for (const entry of state.entries) {
    const msg = state.msgs.get(entry.hash);
    if (!(msg && msg.del)) count += 1;
  }
  return count;
}

function updateHeader() {
  if (!state.active) return;
  setChatHeader(state.active.chat, visibleTotal());
}

/* --- ввод --- */

function autoGrow() {
  const input = refs.input;
  input.style.height = "auto";
  input.style.height = Math.min(Math.max(input.scrollHeight, 46), 160) + "px";
  input.style.overflowY = input.scrollHeight > 160 ? "auto" : "hidden";
}

/* --- события --- */

function wire() {
  byId("btn-new").addEventListener("click", createChat);
  byId("btn-welcome-new").addEventListener("click", createChat);
  byId("btn-settings").addEventListener("click", () => openSetup());
  byId("btn-profile").addEventListener("click", openProfile);
  byId("btn-welcome-profile").addEventListener("click", openProfile);
  byId("btn-chat-settings").addEventListener("click", openChatSettings);
  byId("btn-invite").addEventListener("click", openInviteModal);
  byId("btn-back").addEventListener("click", () => navigate("/"));
  byId("btn-invite-home").addEventListener("click", () => navigate("/"));
  byId("btn-join").addEventListener("click", joinInvite);
  byId("reply-cancel").addEventListener("click", clearReply);

  refs.setup.form.addEventListener("submit", submitSetup);
  refs.profile.form.addEventListener("submit", submitProfile);
  refs.profile.logout.addEventListener("click", logout);
  refs.chatSettings.form.addEventListener("submit", submitChatSettings);
  refs.invite.copy.addEventListener("click", copyInvite);

  refs.feed.addEventListener("scroll", () => {
    if (!state.ready || state.loadingMore || !state.nextBefore) return;
    if (refs.feed.scrollTop < 60) loadMore();
  });

  refs.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });
  refs.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  refs.input.addEventListener("input", autoGrow);

  window.addEventListener("hashchange", route);
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    state.profile = loadProfile();
    state.chats = loadChats();
    state.endpoints = loadEndpoints();
    refreshChrome();
    route();
  });
}

wire();
autoGrow();
refreshChrome();
route();
if (!hasEndpoints(state.endpoints) && !location.hash.startsWith("#/invite/")) {
  openSetup({ force: true });
}
