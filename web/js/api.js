export class ApiError extends Error {
  constructor(status, code) {
    super(code || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code || `http_${status}`;
  }
}

export class Api {
  constructor(base) {
    if (!base) throw new Error("адрес API обязателен");
    this.base = base.replace(/\/+$/, "");
  }

  async _request(path, { method = "GET", body, signal, timeout = 20000 } = {}) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);

    const options = { method, signal: controller.signal };
    if (body !== undefined) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(this.base + path, options);
    } catch (err) {
      if (err?.name === "AbortError") {
        if (signal?.aborted) throw err;
        throw new ApiError(0, "timeout");
      }
      throw new ApiError(0, "network");
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", forwardAbort);
    }
    if (res.ok) return res.json().catch(() => null);

    let code = `http_${res.status}`;
    try {
      const data = await res.json();
      if (data && typeof data.error === "string") code = data.error;
    } catch {
      /* тело не JSON */
    }
    throw new ApiError(res.status, code);
  }

  post(chatId, message) {
    return this._request(`/api/chats/${encodeURIComponent(chatId)}`, {
      method: "POST",
      body: message,
    });
  }

  feed(chatId, { before = 0, limit = 100 } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before > 0) params.set("before", String(before));
    return this._request(`/api/chats/${encodeURIComponent(chatId)}?${params}`);
  }

  head(chatId, after = 0, timeout = 25, signal) {
    const params = new URLSearchParams({ after: String(after), timeout: String(timeout) });
    return this._request(`/api/chats/${encodeURIComponent(chatId)}/head?${params}`, {
      signal,
      timeout: (timeout + 8) * 1000,
    });
  }

  registerId(deviceHash, userHash) {
    return this._request("/api/id", {
      method: "POST",
      body: { device_hash: deviceHash, user_hash: userHash },
    });
  }

  async getId(deviceHash) {
    let res;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      res = await fetch(`${this.base}/api/id/${encodeURIComponent(deviceHash)}`, {
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(res.status, `http_${res.status}`);
    return res.json().catch(() => null);
  }
}
