import { canonicalJSON, sha256Hex } from "../hash.js";
import { isHex64 } from "./util.js";

const PROFILE_KEY = "hash-chat.profile";
const DEVICE_PREFIX = "hash-chat.device.";
const NAME_PREFIX = "hash-chat.name.";

const nameCache = new Map();

export function loadProfile() {
  let profile;
  try {
    profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
  } catch {
    return null;
  }
  if (!profile || typeof profile !== "object") return null;
  if (!isHex64(profile.hash) || !profile.login) return null;
  return {
    ts: Number(profile.ts) || 0,
    login: String(profile.login),
    name: typeof profile.name === "string" ? profile.name : "",
    hash: profile.hash,
    deviceHash: isHex64(profile.deviceHash) ? profile.deviceHash : "",
  };
}

export function saveProfileLocal(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export function clearProfile() {
  localStorage.removeItem(PROFILE_KEY);
}

export async function makeProfile(login, name) {
  const value = {
    ts: Date.now(),
    login: String(login).trim(),
    name: String(name || "").trim(),
  };
  const hash = await sha256Hex(new TextEncoder().encode(canonicalJSON(value)));
  return { ...value, hash };
}

export async function deviceHashFor(profile) {
  if (!profile || !isHex64(profile.hash)) throw new Error("профиль без хэша");

  const key = DEVICE_PREFIX + profile.hash;
  const cached = localStorage.getItem(key);
  if (isHex64(cached)) return cached;

  const fingerprint = {
    ua: navigator.userAgent,
    lang: navigator.language,
    platform: navigator.userAgentData?.platform || navigator.platform || "",
    screen: `${screen.width}x${screen.height}x${screen.colorDepth}`,
    viewport: `${innerWidth}x${innerHeight}`,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzOffset: new Date().getTimezoneOffset(),
    cores: navigator.hardwareConcurrency || 0,
    touch: navigator.maxTouchPoints || 0,
    vendor: navigator.vendor || "",
    memory: navigator.deviceMemory || 0,
    gpu: gpuRenderer(),
    user: profile.hash,
  };
  const hash = await sha256Hex(new TextEncoder().encode(canonicalJSON(fingerprint)));
  localStorage.setItem(key, hash);
  return hash;
}

export function profileLabel(profile) {
  if (!profile) return "анон";
  return profile.name || profile.login || "анон";
}

export async function resolveName(api, cas, deviceHash) {
  if (!isHex64(deviceHash)) return null;
  if (nameCache.has(deviceHash)) return nameCache.get(deviceHash);

  const cached = localStorage.getItem(NAME_PREFIX + deviceHash);
  if (cached) {
    nameCache.set(deviceHash, cached);
    return cached;
  }

  let name = null;
  try {
    const identity = await api.getId(deviceHash);
    if (identity && isHex64(identity.user_hash)) {
      const profile = await cas.get(identity.user_hash);
      if (profile && typeof profile === "object") {
        name = String(profile.name || profile.login || "").trim() || null;
      }
    }
  } catch {
    name = null;
  }

  nameCache.set(deviceHash, name);
  if (name) localStorage.setItem(NAME_PREFIX + deviceHash, name);
  return name;
}

export function clearNameCache() {
  nameCache.clear();
}

function gpuRenderer() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
  } catch {
    return "";
  }
}
