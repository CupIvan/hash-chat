import {
  avatarColor,
  fmtTime,
  h,
  initials,
  shortId,
  truncate,
} from "./util.js";

const byId = (id) => document.getElementById(id);

export const refs = {
  app: byId("app"),
  chatList: byId("chat-list"),
  profileAvatar: byId("profile-avatar"),
  profileName: byId("profile-name"),
  screens: {
    welcome: byId("screen-welcome"),
    chat: byId("screen-chat"),
    invite: byId("screen-invite"),
  },
  chatName: byId("chat-name"),
  chatSub: byId("chat-sub"),
  warning: byId("warning"),
  feed: byId("feed"),
  composer: byId("composer"),
  input: byId("input"),
  send: byId("send"),
  replyBar: byId("reply-bar"),
  replyLink: byId("reply-link"),
  replyCancel: byId("reply-cancel"),
  composerHint: byId("composer-hint"),
  overlay: byId("overlay"),
  toast: byId("toast"),
  setup: {
    form: byId("setup-form"),
    title: byId("setup-title"),
    api: byId("setup-api"),
    cas: byId("setup-cas"),
    error: byId("setup-error"),
    close: byId("setup-close"),
  },
  profile: {
    form: byId("profile-form"),
    login: byId("profile-login"),
    name: byId("profile-name-input"),
    error: byId("profile-error"),
    logout: byId("profile-logout"),
  },
  chatSettings: {
    form: byId("chat-form"),
    name: byId("chat-name-input"),
    server: byId("chat-api"),
    cas: byId("chat-cas"),
    error: byId("chat-error"),
  },
  inviteText: byId("invite-text"),
  inviteId: byId("invite-id"),
  invite: {
    link: byId("invite-link"),
    copy: byId("invite-copy"),
    hint: byId("invite-hint"),
  },
};

let currentModal = null;
let toastTimer = null;

export function setScreen(name) {
  for (const [key, node] of Object.entries(refs.screens)) {
    node.hidden = key !== name;
  }
  refs.app.classList.toggle("chat-open", name !== "welcome");
}

export function openModal(name, { closable = true } = {}) {
  for (const modal of document.querySelectorAll(".modal")) {
    modal.hidden = modal.id !== `modal-${name}`;
  }
  refs.overlay.hidden = false;
  refs.overlay.dataset.closable = closable ? "1" : "0";
  currentModal = name;

  const modal = byId(`modal-${name}`);
  if (!modal) return;
  const first = modal.querySelector("input, textarea, button:not([data-close])");
  setTimeout(() => first?.focus(), 0);
}

export function closeModal(force = false) {
  if (!force && refs.overlay.dataset.closable === "0") return false;
  refs.overlay.hidden = true;
  refs.overlay.dataset.closable = "1";
  for (const modal of document.querySelectorAll(".modal")) modal.hidden = true;
  currentModal = null;
  return true;
}

export function isModalOpen(name) {
  return name ? currentModal === name : currentModal !== null;
}

export function toast(text) {
  refs.toast.textContent = text;
  refs.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    refs.toast.hidden = true;
  }, 2800);
}

export function setWarning(text) {
  refs.warning.hidden = !text;
  refs.warning.textContent = text || "";
}

export function renderChatList(chats, activeId, onOpen) {
  refs.chatList.textContent = "";
  if (!chats.length) {
    refs.chatList.append(
      h("div", { class: "chat-empty" }, [
        h("b", { text: "Чатов пока нет" }),
        h("span", { text: "Создайте новый или откройте ссылку-приглашение." }),
      ]),
    );
    return;
  }

  const sorted = [...chats].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  for (const chat of sorted) {
    const name = chat.name || `/${shortId(chat.id)}/`;
    const avatar = h("span", { class: "chat-avatar", text: initials(chat.name || "#") });
    avatar.style.background = avatarColor(chat.id);
    const item = h(
      "button",
      {
        type: "button",
        class: "chat-item" + (chat.id === activeId ? " active" : ""),
        title: chat.id,
        "aria-current": chat.id === activeId ? "page" : null,
        onclick: () => onOpen(chat.id),
      },
      [
        avatar,
        h("span", { class: "chat-meta" }, [
          h("span", { class: "chat-name", text: name }),
          h("span", { class: "chat-sub", text: shortId(chat.id, 14) }),
        ]),
        h("span", {
          class: "chat-time",
          text: chat.lastTs ? fmtTime(chat.lastTs) : "",
        }),
      ],
    );
    refs.chatList.append(item);
  }
}

export function updateProfileButton(profile) {
  refs.profileAvatar.textContent = profile ? initials(profile.name || profile.login) : "?";
  refs.profileAvatar.style.background = profile ? avatarColor(profile.hash) : "";
  refs.profileName.textContent = profile ? profile.name || profile.login : "Войти";
  refs.profileName.title = profile ? profile.login : "Войти";
}

export function setChatHeader(chat, total) {
  const title = chat.name || `/${shortId(chat.id)}/`;
  refs.chatName.textContent = title;
  refs.chatName.title = chat.id;
  refs.chatSub.textContent = `${total} ${plural(total, "сообщение", "сообщения", "сообщений")} · ${shortId(chat.id, 12)}`;
  document.title = `${title} — hash-chat`;
}

export function setComposerState(profile) {
  refs.input.placeholder = profile ? "Сообщение" : "Войдите, чтобы писать";
  refs.composerHint.textContent = profile ? "" : "Войдите, чтобы отправлять сообщения";
  refs.send.title = profile ? "Отправить" : "Войдите, чтобы писать";
}

export function showReplyBar(text, onJump) {
  refs.replyLink.textContent = "↩ " + truncate(text || "сообщение", 70);
  refs.replyLink.onclick = onJump;
  refs.replyBar.hidden = false;
}

export function hideReplyBar() {
  refs.replyBar.hidden = true;
  refs.replyLink.textContent = "";
  refs.replyLink.onclick = null;
}

export function isNearBottom(threshold = 80) {
  const feed = refs.feed;
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < threshold;
}

export function scrollFeedBottom() {
  requestAnimationFrame(() => {
    refs.feed.scrollTop = refs.feed.scrollHeight;
  });
}

export function focusInput() {
  refs.input.focus();
}

export function setFormError(node, message) {
  node.textContent = message || "";
  node.hidden = !message;
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

refs.overlay.addEventListener("click", (event) => {
  if (event.target === refs.overlay) closeModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

document.addEventListener("click", (event) => {
  const trigger = event.target.closest?.("[data-close]");
  if (trigger) closeModal();
});

export { byId };
