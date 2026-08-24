// Pro / Perso — logique pure. Le Pro/Perso est désormais le TYPE DU COMPTE
// (BankAccount.usage), pas un tag par transaction. Repli : ancien tag de la
// transaction, puis type de l'entité de rattachement.

import type { Affectation, BankAccount, EntityType, Transaction, Usage } from "./types";

export type UsageMode = "tout" | "pro" | "perso";

/** Table id d'entité → type. */
export function entityTypeMap(
  entities: { id: string; type: EntityType }[]
): Map<string, EntityType> {
  return new Map(entities.map((e) => [e.id, e.type]));
}

/** Table id de compte → usage (Pro/Perso) du compte. */
export function accountUsageMap(accounts: BankAccount[]): Map<string, Usage> {
  const m = new Map<string, Usage>();
  for (const a of accounts) if (a.usage === "pro" || a.usage === "perso") m.set(a.id, a.usage);
  return m;
}

/** Usage (Pro/Perso) effectif d'une transaction = celui de SON COMPTE. */
export function usageOf(
  t: Pick<Transaction, "bankAccountId" | "usage" | "entityId">,
  accountUsageById: Map<string, Usage>,
  typeById: Map<string, EntityType>
): Usage {
  const au = accountUsageById.get(t.bankAccountId);
  if (au === "pro" || au === "perso") return au;
  if (t.usage === "pro" || t.usage === "perso") return t.usage; // héritage
  return typeById.get(t.entityId) === "personnel" ? "perso" : "pro";
}

/** Vrai si la transaction entre dans le mode de vue global. */
export function matchesUsage(
  t: Pick<Transaction, "bankAccountId" | "usage" | "entityId">,
  mode: UsageMode,
  accountUsageById: Map<string, Usage>,
  typeById: Map<string, EntityType>
): boolean {
  if (mode === "tout") return true;
  return usageOf(t, accountUsageById, typeById) === mode;
}

export const USAGE_LABEL: Record<Usage, string> = {
  pro: "Pro",
  perso: "Perso",
};

export const AFFECTATION_LABEL: Record<Affectation, string> = {
  activite: "Activité",
  prive: "Privé",
  mixte: "Mixte",
};

export const AFFECTATIONS: Affectation[] = ["activite", "prive", "mixte"];
