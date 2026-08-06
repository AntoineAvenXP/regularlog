import { normalizeLibelle } from "./parsing";
import type { AccountingRule } from "./types";

/**
 * Moteur de suggestion par règles (§6, niveau 1) — 100 % navigateur, coût nul.
 * Une règle matche si le libellé normalisé CONTIENT le motif normalisé.
 * En cas de plusieurs correspondances : priorité la plus haute, puis motif le
 * plus long (le plus spécifique l'emporte).
 */
export function suggestCode(
  libelle: string,
  rules: AccountingRule[]
): AccountingRule | null {
  const norm = normalizeLibelle(libelle);
  let best: AccountingRule | null = null;
  let bestLen = -1;
  for (const r of rules) {
    const m = normalizeLibelle(r.motif);
    if (!m || !norm.includes(m)) continue;
    const bp = best?.priorite ?? 0;
    const rp = r.priorite ?? 0;
    if (best === null || rp > bp || (rp === bp && m.length > bestLen)) {
      best = r;
      bestLen = m.length;
    }
  }
  return best;
}

/** Motif par défaut proposé à partir d'un libellé (mots significatifs). */
export function defaultMotifFromLibelle(libelle: string): string {
  const norm = normalizeLibelle(libelle);
  // On retire les nombres et on garde les 3 premiers mots >= 3 lettres.
  const words = norm
    .split(" ")
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w));
  return words.slice(0, 3).join(" ");
}
