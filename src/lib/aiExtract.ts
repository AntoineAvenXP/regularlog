// Extraction IA d'un relevé (PDF/image) via la route serveur locale.
// Remplace Tesseract + parseStatementText : Claude lit le document et renvoie
// directement le compte détecté + les lignes structurées (date / libellé / montant signé).

export interface AiStatementRow {
  date: string | null;
  libelle: string;
  montant: number | null;
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

export async function extractStatementAI(file: File): Promise<AiExtractResult> {
  const form = new FormData();
  form.append("file", file);

  const res = await fetch("/api/extract-statement", {
    method: "POST",
    body: form,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string }).error || `Erreur ${res.status}`;
    throw new Error(msg);
  }
  const d = data as AiExtractResult;
  return {
    account: d.account ?? null,
    rows: Array.isArray(d.rows) ? d.rows : [],
    truncated: !!d.truncated,
  };
}
