// Extraction IA d'un relevé (PDF/image) via la route serveur locale.
// Remplace Tesseract + parseStatementText : Claude lit le document et renvoie
// directement le compte détecté + les lignes structurées (date / libellé / montant signé).

export interface AiStatementRow {
  date: string | null;
  libelle: string;
  montant: number | null;
  categorie?: string | null;
}

/** Compte détecté sur le relevé (sert à rattacher automatiquement). */
export interface AiDetectedAccount {
  banque: string | null;
  iban: string | null;
  titulaire: string | null;
  periode: string | null;
  usage: "pro" | "perso" | null; // professionnel / personnel détecté via le relevé
}

export interface AiExtractResult {
  account: AiDetectedAccount | null;
  rows: AiStatementRow[];
  truncated: boolean;
}

function normalizeResult(data: unknown): AiExtractResult {
  const d = (data ?? {}) as AiExtractResult;
  return {
    account: d.account ?? null,
    rows: Array.isArray(d.rows) ? d.rows : [],
    truncated: !!d.truncated,
  };
}

/**
 * Lit UNE image de page de relevé (base64 sans préfixe). Appel court et léger :
 * le découpage du PDF en pages + le parallélisme sont gérés par
 * lib/statementExtract. Corps de requête minuscule → pas de limite 413.
 */
export async function extractStatementImage(
  base64: string,
  mediaType: string,
  categories: string[] = []
): Promise<AiExtractResult> {
  const res = await fetch("/api/extract-statement", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64, mediaType, categories }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string }).error || `Erreur ${res.status}`;
    throw new Error(msg);
  }
  return normalizeResult(data);
}

/** Repli : lecture d'un fichier via son URL Storage (téléchargé côté serveur). */
export async function extractStatementByUrl(
  fileDownloadUrl: string,
  fileName: string
): Promise<AiExtractResult> {
  const res = await fetch("/api/extract-statement", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: fileDownloadUrl, name: fileName }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string }).error || `Erreur ${res.status}`;
    throw new Error(msg);
  }
  return normalizeResult(data);
}
