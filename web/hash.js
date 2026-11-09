/* hash.js — мост к контент-адресуемому хранилищу (CAS).
 *
 *   const cas = new HashClient({ endpoint: "https://..." })
 *   const hash = await cas.put(obj)      // sha256 канонического JSON
 *   const obj  = await cas.get(hash)     // из IndexedDB или сети
 *   await cas.getMany([...])             // батч
 *
 * Свойства, на которых держится протокол:
 *   - адрес = sha256(canonicalJSON(obj)); форма одна для всех;
 *   - CAS иммутабелен, поэтому кеш sha256 -> content не инвалидируется;
 *   - «контента ещё нет» — легитимное состояние (MissingError);
 *   - при чтении содержимое пересчитывается по sha256.
 */

export class HashError extends Error {}

export class MissingError extends HashError {
  constructor(hash) {
    super(`контент ещё не загружен: ${hash}`);
    this.hash = hash;
  }
}

const CHUNK_SIZE = 100 * 1024;

export class HashClient {
  constructor({ endpoint, cacheName = "hash-chat-cache" } = {}) {
    if (!endpoint) throw new Error("endpoint обязателен");
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.cacheName = cacheName;
    this.db = null;
    this.cacheDisabled = false;
    this._uploads = new Map();
    this._retries = new Map();
    this._onlineBound = false;
  }

  async put(obj) {
    const bytes = new TextEncoder().encode(canonicalJSON(obj));
    return this.putBinary(bytes, "application/json");
  }

  async putBinary(bytes, mime = "application/octet-stream") {
    const fileHash = await sha256Hex(bytes);
    this._enqueue(fileHash, bytes, mime, 0);
    return fileHash;
  }

  /* upload ждёт фоновую заливку — когда нужно гарантировать контент в CAS. */
  async upload(hash) {
    const pending = this._uploads.get(hash);
    if (pending) await pending;
  }

  async get(hash) {
    const cached = await this._cacheGet(hash);
    if (cached) return decodeJSON(cached, hash);

    const res = await fetchWithTimeout(`${this.endpoint}/sha256/${hash}`, { method: "GET" });
    if (res.status === 404 || res.status === 202) throw new MissingError(hash);
    if (!res.ok) throw new HashError(`CAS ${res.status} на ${hash}`);

    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((await sha256Hex(bytes)) !== hash) throw new HashError(`хэш не сходится: ${hash}`);
    await this._cachePut(hash, bytes);
    return decodeJSON(bytes, hash);
  }

  /* getMany возвращает Map<hash, obj>; отсутствующие в CAS просто пропускает. */
  async getMany(hashes) {
    const out = new Map();
    const missing = [];
    for (const hash of hashes) {
      const cached = await this._cacheGet(hash);
      if (cached) out.set(hash, decodeJSON(cached, hash));
      else missing.push(hash);
    }
    await mapLimit(missing, 6, async (hash) => {
      try {
        out.set(hash, await this.get(hash));
      } catch (err) {
        if (!(err instanceof MissingError)) throw err;
      }
    });
    return out;
  }

  async has(hash) {
    return (await this._cacheGet(hash)) !== null;
  }

  /* --- фоновая заливка --- */

  _enqueue(fileHash, bytes, mime, attempt) {
    const existing = this._uploads.get(fileHash);
    if (existing) return existing;

    const pending = this._upload(fileHash, bytes, mime)
      .catch(() => {
        this._uploads.delete(fileHash);
        this._scheduleRetry(fileHash, bytes, mime, attempt + 1);
      })
      .catch(() => {});
    this._uploads.set(fileHash, pending);
    return pending;
  }

  async _upload(fileHash, bytes, mime) {
    // 1. Локальный кеш — на этом устройстве контент доступен сразу.
    await this._cachePut(fileHash, bytes);

    // 2. CAS: план склейки, затем куски.
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      const part = bytes.slice(offset, offset + CHUNK_SIZE);
      chunks.push({
        hash: await sha256Hex(part),
        size: part.length,
        offset,
        data: part,
      });
    }
    await this._post(
      `/sha256/${fileHash}/info.json`,
      JSON.stringify({
        size: bytes.length,
        mime,
        chunkSize: CHUNK_SIZE,
        chunks: chunks.map(({ hash, size, offset }) => ({ hash, size, offset })),
      }),
    );
    for (const chunk of chunks) {
      await this._post(`/sha256/${chunk.hash}?parent=${fileHash}`, chunk.data, "application/octet-stream");
    }
  }

  _scheduleRetry(fileHash, bytes, mime, attempt) {
    if (this._retries.has(fileHash)) return;
    const delay = Math.min(30000, 1500 * Math.min(attempt, 8));
    const timer = setTimeout(() => {
      this._retries.delete(fileHash);
      this._enqueue(fileHash, bytes, mime, attempt);
    }, delay);
    this._retries.set(fileHash, { timer, bytes, mime, attempt });

    if (!this._onlineBound) {
      this._onlineBound = true;
      window.addEventListener("online", () => {
        for (const [hash, item] of [...this._retries]) {
          clearTimeout(item.timer);
          this._retries.delete(hash);
          this._enqueue(hash, item.bytes, item.mime, item.attempt);
        }
      });
    }
  }

  async _post(path, body, contentType = "application/json") {
    const res = await fetchWithTimeout(this.endpoint + path, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
    if (res.ok) return res;
    let code = "";
    try {
      code = (await res.json()).error || "";
    } catch {
      /* не-JSON тело */
    }
    throw new HashError(`CAS POST ${path}: ${res.status} ${code}`.trim());
  }

  /* --- IndexedDB --- */

  async _open() {
    if (this.db) return this.db;
    if (this.cacheDisabled) throw new Error("indexedDB недоступен");
    const opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.cacheName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("objects");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("indexedDB timeout")), 2000);
    });
    try {
      this.db = await Promise.race([opening, timeout]);
      return this.db;
    } catch (err) {
      this.cacheDisabled = true;
      throw err;
    }
  }

  async _cacheGet(hash) {
    if (this.cacheDisabled) return null;
    try {
      const db = await this._open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("objects", "readonly");
        const req = tx.objectStore("objects").get(hash);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      this.cacheDisabled = true;
      return null;
    }
  }

  async _cachePut(hash, bytes) {
    if (this.cacheDisabled) return;
    try {
      const db = await this._open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("objects", "readwrite");
        tx.objectStore("objects").put(bytes, hash);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* IndexedDB может быть недоступен — работаем без кеша */
    }
  }
}

function decodeJSON(bytes, hash) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HashError(`не JSON: ${hash}`);
  }
}

export function canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJSON(value[key])).join(",") + "}";
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchWithTimeout(url, options = {}, timeout = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") throw new HashError("CAS не отвечает");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      await fn(items[current]);
    }
  });
  await Promise.all(workers);
}
