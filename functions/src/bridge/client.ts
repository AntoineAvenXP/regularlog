// Client Bridge API v3 (agrégation bancaire DSP2). TOUS les appels côté serveur
// (les credentials ne transitent jamais par le navigateur — §4.2).
// Flux calqué sur l'intégration éprouvée du projet Athéna :
//   - POST /v3/aggregation/users            { external_user_id } (création)
//   - POST /v3/aggregation/authorization/token { external_user_id } → access_token
//   - autres endpoints : Bearer access_token
//   - transactions : PAR compte (account_id), paginées via pagination.next_uri

import { BRIDGE_CLIENT_ID, BRIDGE_CLIENT_SECRET } from "../config";

const BASE = "https://api.bridgeapi.io";
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
    throw new Error(`Bridge ${opts.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/**
 * Jeton d'accès user-scoped à partir de l'external_user_id. Si l'utilisateur
 * n'existe pas encore, on le crée puis on réessaie (create une seule fois).
 */
export async function getToken(externalUserId: string): Promise<string> {
  const body = { external_user_id: externalUserId };
  try {
    const t = await req<{ access_token: string }>(
      "/v3/aggregation/authorization/token",
      { method: "POST", body }
    );
    return t.access_token;
  } catch {
    await req<{ uuid: string }>("/v3/aggregation/users", { method: "POST", body });
    const t = await req<{ access_token: string }>(
      "/v3/aggregation/authorization/token",
      { method: "POST", body }
    );
    return t.access_token;
  }
}

/** URL de connexion des banques (Bridge Connect) à ouvrir par l'utilisateur. */
export async function connectSession(token: string): Promise<string> {
  const s = await req<{ url?: string; redirect_url?: string }>(
    "/v3/aggregation/connect-sessions",
    { method: "POST", token, body: {} }
  );
  return s.url ?? s.redirect_url ?? "";
}

export interface BridgeAccount {
  id: number;
  name: string;
  iban?: string | null;
}

interface Paginated<T> {
  resources: T[];
  pagination?: { next_uri?: string | null };
}

export async function listAccounts(token: string): Promise<BridgeAccount[]> {
  const all: BridgeAccount[] = [];
  let path: string | null = "/v3/aggregation/accounts?limit=200";
  while (path) {
    const page: Paginated<BridgeAccount> = await req(path, { token });
    all.push(...(page.resources ?? []));
    path = page.pagination?.next_uri ?? null;
  }
  return all;
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

/** Transactions d'UN compte Bridge (paginées). */
export async function listTransactions(
  token: string,
  accountId: number
): Promise<BridgeTransaction[]> {
  const all: BridgeTransaction[] = [];
  let path: string | null = `/v3/aggregation/transactions?account_id=${accountId}&limit=500`;
  let guard = 0;
  while (path && guard++ < 500) {
    const page: Paginated<BridgeTransaction> = await req(path, { token });
    all.push(...(page.resources ?? []));
    path = page.pagination?.next_uri ?? null;
  }
  return all;
}
