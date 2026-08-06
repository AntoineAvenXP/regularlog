import type { Transaction } from "./types";

export interface FlowPair {
  pos: Transaction; // le crédit (montant > 0)
  neg: Transaction; // le débit (montant < 0)
  days: number;
}

function daysBetween(a: string, b: string): number {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return Infinity;
  return Math.abs(da - db) / 86_400_000;
}

/**
 * Détecte les virements entre deux comptes de l'outil (§7) :
 * montants exactement opposés, comptes DISTINCTS, dates proches (≤ maxDays).
 * On ignore les transactions déjà marquées flux interne / déjà liées.
 * Appariement au plus proche en date, chaque ligne utilisée une seule fois.
 */
export function detectInternalFlowPairs(
  tx: Transaction[],
  maxDays = 4
): FlowPair[] {
  const byAmount = new Map<string, Transaction[]>();
  for (const t of tx) {
    if (t.fluxInterne || t.transactionMiroirId) continue;
    const key = Math.abs(t.montant).toFixed(2);
    if (Number(key) === 0) continue;
    const list = byAmount.get(key);
    if (list) list.push(t);
    else byAmount.set(key, [t]);
  }

  const used = new Set<string>();
  const pairs: FlowPair[] = [];
  for (const list of byAmount.values()) {
    const pos = list.filter((t) => t.montant > 0);
    const neg = list.filter((t) => t.montant < 0);
    for (const p of pos) {
      if (used.has(p.id)) continue;
      let best: Transaction | null = null;
      let bestDays = Infinity;
      for (const n of neg) {
        if (used.has(n.id)) continue;
        if (n.bankAccountId === p.bankAccountId) continue;
        const d = daysBetween(p.dateOperation, n.dateOperation);
        if (d <= maxDays && d < bestDays) {
          best = n;
          bestDays = d;
        }
      }
      if (best) {
        used.add(p.id);
        used.add(best.id);
        pairs.push({ pos: p, neg: best, days: bestDays });
      }
    }
  }
  return pairs;
}
