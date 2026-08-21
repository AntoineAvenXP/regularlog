// Extraction IA d'un relevé (PDF/image) via la route serveur locale.
// Remplace Tesseract + parseStatementText : Claude lit le document et renvoie
// directement les lignes structurées (date / libellé / montant signé).

export interface AiStatementRow {
  date: string | null;
  libelle: string;
  montant: number | null;
}

export interface AiExtractResult {
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
  return {
    rows: Array.isArray((data as AiExtractResult).rows) ? (data as AiExtractResult).rows : [],
    truncated: !!(data as AiExtractResult).truncated,
  };
}
