// Extraction IA d'un relevé (PDF/image) via la route serveur locale.
// Remplace Tesseract + parseStatementText : Claude lit le document et renvoie
// directement le compte détecté + les lignes structurées (date / libellé / montant signé).

export interface AiStatementRow {
  date: string | null;
  libelle: string;
  montant: number | null;
  categorie?: string | null;
  affectation?: "activite" | "prive" | "mixte" | null;
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

import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";

function normalizeResult(data: unknown): AiExtractResult {
  const d = (data ?? {}) as AiExtractResult;
  return {
    account: d.account ?? null,
    rows: Array.isArray(d.rows) ? d.rows : [],
    truncated: !!d.truncated,
  };
}

/**
 * Lit UNE image de page de relevé (base64 sans préfixe) via la Cloud Function
 * `extractStatement` (Opus, europe-west1) : pas de limite de durée courte comme
 * sur Vercel. Le découpage en pages + le parallélisme sont gérés par
 * lib/statementExtract. Timeout client porté à 300 s (Opus peut être lent).
 */
export async function extractStatementImage(
  base64: string,
  mediaType: string,
  categories: string[] = []
): Promise<AiExtractResult> {
  const fn = httpsCallable<
    { image: string; mediaType: string; categories: string[] },
    AiExtractResult
  >(functions, "extractStatement", { timeout: 300000 });
  try {
    const { data } = await fn({ image: base64, mediaType, categories });
    return normalizeResult(data);
  } catch (e) {
    throw new Error((e as { message?: string }).message || "Erreur IA");
  }
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
