import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "../config";

export interface Extracted {
  date: string | null;
  montant: number | null;
  emetteur: string | null;
  numeroPiece: string | null;
}

const EMPTY: Extracted = { date: null, montant: null, emetteur: null, numeroPiece: null };

/** Extraction IA des métadonnées d'un justificatif (PDF ou image). Best-effort :
 *  en cas d'échec, renvoie des champs nuls → le justificatif part en file
 *  manuelle plutôt que d'être perdu (§8). Modèle éco (Haiku) pour le coût. */
export async function extractFromDocument(
  buffer: Buffer,
  mime: string,
  filename: string
): Promise<Extracted> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  const b64 = buffer.toString("base64");

  // Typage souple : le bloc « document » (PDF) n'est pas encore dans le typage
  // stable du SDK 0.30, mais l'API et les modèles Claude actuels l'acceptent.
  const content: unknown[] = [];
  if (mime === "application/pdf" || /\.pdf$/i.test(filename)) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: b64 },
    });
  } else if (mime.startsWith("image/")) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: mime, data: b64 },
    });
  } else {
    return EMPTY;
  }
  content.push({
    type: "text",
    text:
      "Ce document est un justificatif comptable (facture, ticket, reçu). " +
      'Réponds UNIQUEMENT par un JSON strict : {"date":"AAAA-MM-JJ|null",' +
      '"montant":nombre|null,"emetteur":"texte|null","numeroPiece":"texte|null"}. ' +
      "montant = total TTC. Aucune autre sortie que le JSON.",
  });

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [{ role: "user", content: content as any }],
    });
    const text = msg.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return EMPTY;
    const j = JSON.parse(json);
    return {
      date: j.date || null,
      montant: j.montant != null && j.montant !== "" ? Number(j.montant) : null,
      emetteur: j.emetteur || null,
      numeroPiece: j.numeroPiece || null,
    };
  } catch {
    return EMPTY;
  }
}

interface TxLike {
  id: string;
  montant: number;
  dateOperation: string;
  libelleBrut: string;
}

/** Cherche la transaction correspondante (montant identique, date proche,
 *  émetteur dans le libellé) et renvoie un score de confiance [0..1]. */
export function matchTransaction(
  ex: Extracted,
  txs: TxLike[]
): { transactionId: string; score: number; motif: string } | null {
  if (ex.montant == null) return null;
  const target = Math.abs(ex.montant);
  let best: { transactionId: string; score: number; motif: string } | null = null;

  for (const t of txs) {
    if (Math.abs(Math.abs(t.montant) - target) > 0.01) continue; // montant identique
    let score = 0.5;
    const motifs: string[] = ["montant identique"];

    if (ex.date && t.dateOperation) {
      const d = Math.abs((Date.parse(ex.date) - Date.parse(t.dateOperation)) / 86_400_000);
      if (d < 1) score += 0.3;
      else if (d <= 3) score += 0.2;
      else if (d <= 7) score += 0.1;
      else continue; // trop loin en date
      motifs.push(`date ±${Math.round(d)} j`);
    }
    if (ex.emetteur) {
      const token = ex.emetteur.toLowerCase().split(/\s+/)[0];
      if (token && t.libelleBrut.toLowerCase().includes(token)) {
        score += 0.2;
        motifs.push("émetteur");
      }
    }
    if (!best || score > best.score) {
      best = { transactionId: t.id, score: Math.min(1, score), motif: motifs.join(", ") };
    }
  }
  return best;
}
