// Client Bridge API v3 (agrégation bancaire DSP2). TOUS les appels côté serveur
// (les credentials ne transitent jamais par le navigateur — §4.2).
// Réf. flux d'auth : POST /users = { external_user_id } ; les autres endpoints
// exigent un Bearer access_token user-scoped.

import { BRIDGE_CLIENT_ID, BRIDGE_CLIENT_SECRET } from "../config";

const BASE = "https://api.bridgeapi.io/v3";
const BRIDGE_VERSION = "2025-01-15";

function baseHeaders(): Record<string, string> {
  return {
    "Client-Id": BRIDGE_CLIENT_ID.value(),
    "Client-Secret": BRIDGE_CLIENT_SECRET.value(),
    "Bridge-Version": BRIDGE_VERSION,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function req<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {}
): Promise<T> {
  const headers = baseHeaders();
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Bridge ${opts.method ?? "GET"} ${path} → ${res.status}: ${txt}`);
  }
  return (await res.json()) as T;
}

interface BridgeUser {
  uuid: string;
  external_user_id: string;
}

/** Crée (ou retrouve) l'utilisateur Bridge lié à l'uid propriétaire. */
export async function ensureUser(externalUserId: string): Promise<string> {
  try {
    const u = await req<BridgeUser>("/aggregation/users", {
      method: "POST",
      body: { external_user_id: externalUserId },
    });
    return u.uuid;
  } catch {
    const list = await req<{ resources: BridgeUser[] }>(
      `/aggregation/users?external_user_id=${encodeURIComponent(externalUserId)}`
    );
    const found = list.resources?.find((x) => x.external_user_id === externalUserId);
    if (found) return found.uuid;
    throw new Error("Utilisateur Bridge introuvable.");
  }
}

/** Jeton d'accès user-scoped (courte durée). */
export async function userToken(userUuid: string): Promise<string> {
  const t = await req<{ access_token: string }>(
    "/aggregation/authorization/token",
    { method: "POST", body: { user_uuid: userUuid } }
  );
  return t.access_token;
}

/** URL de connexion des banques (Bridge Connect) à ouvrir par l'utilisateur. */
export async function connectSession(token: string): Promise<string> {
  const s = await req<{ url?: string; redirect_url?: string }>(
    "/aggregation/connect-sessions",
    { method: "POST", token, body: {} }
  );
  return s.url ?? s.redirect_url ?? "";
}

export interface BridgeAccount {
  id: number;
  name: string;
  iban?: string | null;
  balance?: number;
}

export async function listAccounts(token: string): Promise<BridgeAccount[]> {
  const r = await req<{ resources: BridgeAccount[] }>("/aggregation/accounts", { token });
  return r.resources ?? [];
}

export interface BridgeTransaction {
  id: number;
  account_id: number;
  date?: string;
  booking_date?: string;
  amount: number;
  clean_description?: string;
  provider_description?: string;
}

/** Toutes les transactions (pagination suivie via next_uri). */
export async function listTransactions(token: string): Promise<BridgeTransaction[]> {
  const out: BridgeTransaction[] = [];
  // next_uri renvoyé par Bridge est un chemin relatif (ex. "/v3/aggregation/...").
  let path: string | null = "/aggregation/transactions?limit=500";
  let guard = 0;
  while (path && guard++ < 200) {
    const r: { resources: BridgeTransaction[]; pagination?: { next_uri?: string } } =
      await req(path, { token });
    out.push(...(r.resources ?? []));
    const next = r.pagination?.next_uri ?? null;
    path = next ? next.replace(/^\/v3/, "") : null;
  }
  return out;
}
