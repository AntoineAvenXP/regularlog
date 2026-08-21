import { NextRequest, NextResponse } from "next/server";

// Extraction IA d'un relevé bancaire (PDF ou image) → lignes structurées.
// Tourne côté SERVEUR (Node) : la clé Anthropic reste dans .env.local et n'est
// JAMAIS exposée au navigateur. Aucune dépendance à Cloud Functions / facturation
// Google — c'est l'API Anthropic qui est facturée (compte Anthropic).
export const runtime = "nodejs";
export const maxDuration = 120;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

interface ExtractedRow {
  date: string | null;
  libelle: string;
  montant: number | null;
}

const PROMPT =
  "Ce document est un relevé de compte bancaire. Extrais TOUTES les lignes d'opération, " +
  "sans en oublier ni en inventer.\n" +
  "Réponds UNIQUEMENT par un tableau JSON strict, sans aucun texte autour, au format :\n" +
  '[{"date":"AAAA-MM-JJ","libelle":"texte","montant":nombre}]\n' +
  "Règles :\n" +
  "- date = date d'opération (à défaut date de valeur), format ISO AAAA-MM-JJ.\n" +
  "- libelle = libellé complet de l'opération (bénéficiaire, motif, référence).\n" +
  "- montant = montant signé en euros : NEGATIF pour un débit / retrait / paiement / prélèvement, " +
  "POSITIF pour un crédit / virement reçu / versement. Point décimal, pas de symbole ni de séparateur de milliers.\n" +
  "- Ignore les soldes, totaux, sous-totaux, en-têtes et pieds de page : uniquement les opérations.\n" +
  "- Si aucune opération n'est lisible, réponds []." ;

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Clé ANTHROPIC_API_KEY absente de .env.local (côté serveur)." },
      { status: 500 }
    );
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    file = form.get("file") as File | null;
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  if (!file) {
    return NextResponse.json({ error: "Aucun fichier reçu." }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const b64 = buf.toString("base64");
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: any[] = [];
  if (isPdf) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: b64 },
    });
  } else if (file.type.startsWith("image/")) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: file.type, data: b64 },
    });
  } else {
    return NextResponse.json(
      { error: "Format non supporté (PDF ou image uniquement)." },
      { status: 400 }
    );
  }
  content.push({ type: "text", text: PROMPT });

  let resp: Response;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8192,
        messages: [{ role: "user", content }],
      }),
    });
  } catch (e) {
    return NextResponse.json(
      { error: "Appel Anthropic impossible : " + (e as Error).message },
      { status: 502 }
    );
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return NextResponse.json(
      { error: `Anthropic HTTP ${resp.status}`, detail: detail.slice(0, 500) },
      { status: 502 }
    );
  }

  const data = (await resp.json()) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
  };
  const text = (data.content || [])
    .map((c) => (c.type === "text" ? c.text || "" : ""))
    .join("");

  const jsonSlice = text.match(/\[[\s\S]*\]/)?.[0];
  if (!jsonSlice) {
    return NextResponse.json(
      { error: "Réponse IA illisible.", raw: text.slice(0, 300) },
      { status: 502 }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return NextResponse.json(
      { error: "JSON IA invalide.", raw: jsonSlice.slice(0, 300) },
      { status: 502 }
    );
  }
  if (!Array.isArray(parsed)) {
    return NextResponse.json({ error: "Format IA inattendu." }, { status: 502 });
  }

  const rows: ExtractedRow[] = parsed.map((r) => {
    const o = (r || {}) as Record<string, unknown>;
    const m = o.montant;
    return {
      date: typeof o.date === "string" && o.date ? o.date : null,
      libelle: typeof o.libelle === "string" ? o.libelle : "",
      montant:
        m != null && m !== "" && !Number.isNaN(Number(m)) ? Number(m) : null,
    };
  });

  // stop_reason "max_tokens" = relevé trop long, réponse tronquée → on prévient.
  const truncated = data.stop_reason === "max_tokens";
  return NextResponse.json({ rows, truncated });
}
