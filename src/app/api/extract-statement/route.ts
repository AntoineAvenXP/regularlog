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

interface DetectedAccount {
  banque: string | null;
  iban: string | null; // IBAN complet ou partiel tel qu'imprimé
  titulaire: string | null;
  periode: string | null; // ex. "2024-01" ou "janvier 2024"
  usage: "pro" | "perso" | null; // professionnel ou personnel, déduit du relevé
}

const PROMPT =
  "Ce document est un relevé de compte bancaire. Tu dois (1) identifier le compte " +
  "et (2) extraire TOUTES les lignes d'opération, sans en oublier ni en inventer.\n" +
  "Réponds UNIQUEMENT par un objet JSON strict, sans aucun texte autour, au format :\n" +
  '{"compte":{"banque":"texte|null","iban":"texte|null","titulaire":"texte|null","periode":"AAAA-MM|null","usage":"pro|perso|null"},' +
  '"operations":[{"date":"AAAA-MM-JJ","libelle":"texte","montant":nombre}]}\n' +
  "Règles pour \"compte\" :\n" +
  "- banque = nom de la banque émettrice du relevé (ex. Qonto, BNP Paribas, Crédit Agricole).\n" +
  "- iban = IBAN du compte tel qu'imprimé (complet ou partiel), sinon null.\n" +
  "- titulaire = nom du titulaire du compte, sinon null.\n" +
  "- periode = mois principal du relevé au format AAAA-MM, sinon null.\n" +
  "- usage = \"pro\" si le compte est professionnel (titulaire = société / entreprise, " +
  "SIRET/TVA visible, banque pro type Qonto/Shine, opérations d'activité), \"perso\" si " +
  "compte de particulier (salaire, courses, loyer personnel), sinon null si incertain.\n" +
  "Règles pour \"operations\" :\n" +
  "- date = date d'opération (à défaut date de valeur), format ISO AAAA-MM-JJ.\n" +
  "- libelle = libellé complet de l'opération (bénéficiaire, motif, référence).\n" +
  "- montant = montant signé en euros : NEGATIF pour un débit / retrait / paiement / prélèvement, " +
  "POSITIF pour un crédit / virement reçu / versement. Point décimal, pas de symbole ni de séparateur de milliers.\n" +
  "- Ignore les soldes, totaux, sous-totaux, en-têtes et pieds de page : uniquement les opérations.\n" +
  "- Si aucune opération n'est lisible, renvoie \"operations\":[] (mais remplis \"compte\" si possible)." ;

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

  // Format actuel = objet {compte, operations}. On tolère aussi l'ancien format
  // (tableau nu d'opérations) au cas où le modèle régresse.
  const objSlice = text.match(/\{[\s\S]*\}/)?.[0];
  const arrSlice = text.match(/\[[\s\S]*\]/)?.[0];
  const jsonSlice = objSlice || arrSlice;
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

  let rawRows: unknown[] = [];
  let account: DetectedAccount | null = null;
  if (Array.isArray(parsed)) {
    rawRows = parsed;
  } else if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    rawRows = Array.isArray(o.operations) ? o.operations : [];
    const c = (o.compte || null) as Record<string, unknown> | null;
    if (c) {
      const str = (v: unknown) =>
        typeof v === "string" && v.trim() ? v.trim() : null;
      const u = str(c.usage)?.toLowerCase();
      account = {
        banque: str(c.banque),
        iban: str(c.iban),
        titulaire: str(c.titulaire),
        periode: str(c.periode),
        usage: u === "pro" || u === "perso" ? u : null,
      };
    }
  } else {
    return NextResponse.json({ error: "Format IA inattendu." }, { status: 502 });
  }

  const rows: ExtractedRow[] = rawRows.map((r) => {
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
  return NextResponse.json({ account, rows, truncated });
}
