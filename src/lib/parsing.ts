// Normalisation & parsing — utilisés par la déduplication (§5) et l'import (§4).

/** Libellé normalisé : minuscules, sans accents, sans ponctuation, espaces réduits. */
export function normalizeLibelle(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Empreinte de déduplication (§5) : compte + date + montant + libellé normalisé.
 * Deux lignes identiques le même jour peuvent exister réellement → l'empreinte
 * sert à SIGNALER un doublon présumé, jamais à écraser automatiquement.
 */
export function fingerprint(
  bankAccountId: string,
  dateOperation: string,
  montant: number,
  libelle: string
): string {
  return [
    bankAccountId,
    dateOperation,
    montant.toFixed(2),
    normalizeLibelle(libelle),
  ].join("|");
}

/** Parse un montant texte → nombre signé. Gère séparateur décimal , ou . */
export function parseAmount(
  raw: unknown,
  decimal: "," | "." = ","
): number | null {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/\s/g, "").replace(/[€$]/g, "");
  if (s === "") return null;
  if (decimal === ",") {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse une date texte → ISO yyyy-mm-dd. Gère dd/mm/yyyy, yyyy-mm-dd, dd-mm-yy… */
export function parseDate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

/** Formatage montant pour affichage (€, 2 décimales, signe). */
export function fmtAmount(n: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(n);
}
