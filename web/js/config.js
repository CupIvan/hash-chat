import { normalizeBase, parseBase } from "./util.js";

export const DEFAULT_ENDPOINTS = {
  api: "",
  cas: "",
};

const API_KEY = "hash-chat.api";
const CAS_KEY = "hash-chat.cas";

export function loadEndpoints() {
  return {
    api: normalizeBase(localStorage.getItem(API_KEY) ?? DEFAULT_ENDPOINTS.api),
    cas: normalizeBase(localStorage.getItem(CAS_KEY) ?? DEFAULT_ENDPOINTS.cas),
  };
}

export function saveEndpoints({ api, cas }) {
  const normalizedApi = parseBase(api);
  const normalizedCas = parseBase(cas);
  if (!normalizedApi || !normalizedCas) {
    throw new Error("укажите адреса API и CAS");
  }
  localStorage.setItem(API_KEY, normalizedApi);
  localStorage.setItem(CAS_KEY, normalizedCas);
  return { api: normalizedApi, cas: normalizedCas };
}

export function hasEndpoints(endpoints) {
  return Boolean(endpoints && endpoints.api && endpoints.cas);
}

export function endpointsForChat(chat, global) {
  return {
    api: normalizeBase(chat.server) || global.api,
    cas: normalizeBase(chat.cas) || global.cas,
  };
}
