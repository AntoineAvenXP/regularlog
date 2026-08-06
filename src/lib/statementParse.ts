import { parseAmount, parseDate } from "./parsing";

export interface RawRow {
  date: string | null;
  libelle: string;
  montant: number | null;
  raw: string;
}

// Une date en début/milieu de ligne.
const DATE_RE = /(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}-\d{2}-\d{2})/;
// Un montant en fin de ligne (les relevés terminent la ligne par le montant).
const AMOUNT_END_RE =
  /(-?\d{1,3}(?:[ .]\d{3})*[.,]\d{2}|-?\d+[.,]\d{2})\s*(?:€|EUR)?\s*$/;

/**
 * Parseur heuristique d'un texte de relevé (PDF texte ou OCR) → lignes
 * candidates. On ne garde que les lignes contenant À LA FOIS une date ET un
 * montant en fin de ligne. Tout est ensuite RELU/corrigé par l'utilisateur
 * dans l'écran de vérification — rien n'est écrit sans validation.
 */
export function parseStatementText(
  text: string,
  decimal: "," | "." = ","
): RawRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rows: RawRow[] = [];
  for (const line of lines) {
    const dm = line.match(DATE_RE);
    const am = line.match(AMOUNT_END_RE);
    if (!dm || !am) continue;
    const date = parseDate(dm[1]);
    const montant = parseAmount(am[1], decimal);
    const libelle = line
      .replace(am[0], "")
      .replace(dm[0], "")
      .replace(/\s+/g, " ")
      .trim();
    rows.push({ date, libelle, montant, raw: line });
  }
  return rows;
}
