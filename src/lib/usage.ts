// Pro / Perso — logique pure de résolution et de filtrage.
// L'usage d'une transaction est soit explicitement fixé (override par ligne),
// soit déduit du type de l'entité de rattachement (société = pro, perso = perso).

import type { EntityType, Transaction, Usage } from "./types";

export type UsageMode = "tout" | "pro" | "perso";

/** Table id d'entité → type, pour résoudre l'usage sans recharger les entités. */
export function entityTypeMap(
  entities: { id: string; type: EntityType }[]
): Map<string, EntityType> {
  return new Map(entities.map((e) => [e.id, e.type]));
}

/** Usage effectif d'une transaction (override sinon déduit de l'entité). */
export function usageOf(
  t: Pick<Transaction, "usage" | "entityId">,
  typeById: Map<string, EntityType>
): Usage {
  if (t.usage === "pro" || t.usage === "perso") return t.usage;
  return typeById.get(t.entityId) === "personnel" ? "perso" : "pro";
}

/** Vrai si la transaction entre dans le mode de vue global. */
export function matchesUsage(
  t: Pick<Transaction, "usage" | "entityId">,
  mode: UsageMode,
  typeById: Map<string, EntityType>
): boolean {
  if (mode === "tout") return true;
  return usageOf(t, typeById) === mode;
}

export const USAGE_LABEL: Record<Usage, string> = {
  pro: "Pro",
  perso: "Perso",
};
