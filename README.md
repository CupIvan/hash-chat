# hash-chat

**Быстрый чат на хэшах.** Сообщение — контент-адресуемый объект: его адрес —
`sha256` канонического JSON. Содержимое хранит CAS, сервер координации —
только хэши, порядок и цепочку `prev`. Браузер кеширует контент и проверяет
целостность.

Сервер не читает сообщения и не может изменить уже отправленное — но может
задерживать доставку, скрывать записи или дописывать свои.

**Открыть:** [cupivan.github.io/hash-chat](https://cupivan.github.io/hash-chat/)

При первом запуске приложение спросит адреса API и CAS; они хранятся только
в браузере. Сервер должен разрешать origin страницы (CORS).

## Как это работает

```
браузер ── API: хэши, seq, prev ──► hashchat
   └───── CAS: контент по sha256 ──► hash-server
```

- **CAS** ([hash-server](https://github.com/CupIvan/hash-server)) — «что
  сказано»: отдаёт объект по адресу и сверяет адрес с содержимым.
- **hashchat** — «кто сказал и в каком порядке»: append-only лента хэшей,
  серверный `seq`, цепочка `prev`, пара `deviceHash → userHash`.
- **Браузер** — канонизация, хэширование, IndexedDB-кеш, проверка целостности
  и восстановление ленты по цепочке.

## Почему быстрый

- Хэш известен до сети: сообщение отправляется сразу, контент доливается в
  CAS в фоне.
- Кеш `sha256 → content` в IndexedDB вечный — CAS иммутабелен.
- Long-poll отдаёт только хвост ленты; остальное клиент добирает по `prev`.
- `getMany` ходит в сеть только за недостающим.

## Сообщение и цепочка

```json
{
  "ts": 1792496909824,
  "text": "привет",
  "author": "<deviceHash>",
  "prev": "<хэш предыдущего сообщения; у первого — пусто>",
  "reply": "<необязательно: хэш цитируемого>"
}
```

`prev` входит в содержимое и в хэш, поэтому лента — цепочка. Сервер принимает
запись только с `prev`, равным хвосту, иначе `409 prev_mismatch`; клиент
перечитывает хвост и повторяет. При загрузке клиент сверяет каждый `prev` с
предыдущим хэшем.

Удаление — не мутация, а ещё одна запись:

```json
{ "ts": 1792496909824, "author": "<deviceHash>", "prev": "<хвост>", "del": "<hash>" }
```

Оригинал остаётся в CAS, в ленте — заглушка «сообщение удалено».

## Идентичность

```
userHash   = sha256(canonicalJSON({ts, login, name}))
deviceHash = sha256(canonicalJSON({отпечаток браузера, user: userHash}))
chatId     = sha256(canonicalJSON({ts, deviceHash}))
```

Профиль — контент в CAS по адресу `userHash`. Сервер идентификации хранит
только пару хэшей: `GET /api/id/{deviceHash} → userHash`. Имя резолвится
клиентом через CAS; паролей нет, личность и список чатов — в localStorage.

## API

```
POST /api/chats/{chatId}        {hash, prev, ts} → 201 {entry}
GET  /api/chats/{chatId}        ?before=&limit= → {entries, total, next_before}
GET  /api/chats/{chatId}/head   ?after=&timeout= — long-poll {seq, head}
POST /api/id                    {device_hash, user_hash} → 201
GET  /api/id/{deviceHash}       → {user_hash} | 404 unknown_device
```

`chatId` — `[A-Za-z0-9_-]{1,64}`, `hash`/`prev` — 64 hex. Ошибки — JSON с
полем `error`. Лимиты: тело 4 КиБ, страница 500 записей, long-poll 30 с.

## Приглашения

Код — `base64url(canonicalJSON({chat, user?, server?, cas?}))`: чат, автор и,
если нужно, свои адреса API и CAS. Серверных приглашений нет — код
самодостаточен.

## CAS

Отдельный сервис: `GET /sha256/{hash}` отдаёт контент, `POST` принимает план
и куски; адрес всегда равен `sha256` содержимого. `hash.js` — мост:

```js
const hash = new HashClient({ endpoint: CAS_URL })
const h = await hash.put(message)   // sha256 сразу, заливка в фоне
const msg = await hash.get(h)       // IndexedDB → сеть, с проверкой sha256
```

## Пример использования

Открой приложение, войди, создай чат и отправь ссылку-приглашение. Под капотом
отправка и чтение выглядят так:

```js
import { HashClient } from "./hash.js";

// CAS_URL, API_URL, deviceHash, chatId и prev — из настроек чата
const cas = new HashClient({ endpoint: CAS_URL });

// отправка: prev — хэш последнего сообщения чата ("" у нового чата)
const msg = { ts: Date.now(), text: "привет", author: deviceHash, prev };
const h = await cas.put(msg);        // sha256 сразу, заливка в CAS — в фоне
await fetch(`${API_URL}/api/chats/${chatId}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ hash: h, prev, ts: msg.ts }),
});

// чтение: лента — хэши, содержимое — из кеша или CAS
const feed = await fetch(`${API_URL}/api/chats/${chatId}`).then((r) => r.json());
const messages = await cas.getMany(feed.entries.map((e) => e.hash));
```
