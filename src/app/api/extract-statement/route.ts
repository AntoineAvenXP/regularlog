import { NextRequest, NextResponse } from "next/server";

// Extraction IA d'un relevé bancaire (PDF ou image) → lignes structurées.
// Tourne côté SERVEUR (Node) : la clé Anthropic reste dans .env.local et n'est
// JAMAIS exposée au navigateur. Aucune dépendance à Cloud Functions / facturation
// Google — c'est l'API Anthropic qui est facturée (compte Anthropic).
export const runtime = "nodejs";
// Une page à la fois (le PDF est découpé côté client) → appels courts et
// parallèles. 60 s est large et compatible tous plans Vercel.
export const maxDuration = 60;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

interface ExtractedRow {
  date: string | null;
  libelle: string;
  montant: number | null;
  categorie: string | null;
  affectation: "activite" | "prive" | "mixte" | null;
}

interface DetectedAccount {
  banque: string | null;
  iban: string | null; // IBAN complet ou partiel tel qu'imprimé
  titulaire: string | null;
  periode: string | null; // ex. "2024-01" ou "janvier 2024"
  usage: "pro" | "perso" | null; // professionnel ou personnel, déduit du relevé
}

function buildPrompt(categories: string[]): string {
  const catRule =
    categories.length > 0
      ? "- categorie = LA catégorie la plus adaptée à l'opération, choisie EXACTEMENT dans cette liste : [" +
        categories.join(", ") +
        "]. Si vraiment aucune ne convient, mets null.\n"
      : '- categorie = courte catégorie usuelle de l\'opération (ex. "Nourriture", "Énergie", "Transport", "Salaires"), sinon null.\n';
  return PROMPT_HEAD + catRule + PROMPT_TAIL;
}

const PROMPT_HEAD =
  "Ce document est un relevé de compte bancaire. Tu dois (1) identifier le compte " +
  "et (2) extraire TOUTES les lignes d'opération, sans en oublier ni en inventer.\n" +
  "Réponds UNIQUEMENT par un objet JSON strict, sans aucun texte autour, au format :\n" +
  '{"compte":{"banque":"texte|null","iban":"texte|null","titulaire":"texte|null","periode":"AAAA-MM|null","usage":"pro|perso|null"},' +
  '"operations":[{"date":"AAAA-MM-JJ","libelle":"texte","montant":nombre,"categorie":"texte|null","affectation":"activite|prive|mixte"}]}\n' +
  "IMPORTANT — plusieurs comptes possibles : un même document (ou une même page) " +
  "peut concerner PLUSIEURS comptes bancaires différents. Repère-les grâce à leur " +
  "NUMÉRO DE COMPTE / IBAN. Le champ \"compte\" doit décrire le compte auquel " +
  "appartiennent les opérations que tu renvoies pour CETTE page. Si les opérations " +
  "de la page changent de compte, renvoie le compte le plus représentatif et veille " +
  "à toujours reporter son numéro/IBAN. Reporte TOUJOURS le numéro/IBAN quand il est " +
  "visible, même partiel : c'est lui qui permet de distinguer les comptes.\n" +
  "Règles pour \"compte\" :\n" +
  "- banque = nom de la banque émettrice du relevé (ex. Qonto, BNP Paribas, Crédit Agricole).\n" +
  "- iban = IBAN ou numéro de compte tel qu'imprimé (complet ou partiel), sinon null. " +
  "Ne l'invente jamais ; recopie-le exactement.\n" +
  "- titulaire = nom du titulaire du compte, sinon null.\n" +
  "- periode = mois principal du relevé au format AAAA-MM, sinon null.\n" +
  "- usage = \"pro\" si le compte est professionnel (titulaire = société / entreprise, " +
  "SIRET/TVA visible, banque pro type Qonto/Shine, opérations d'activité), \"perso\" si " +
  "compte de particulier (salaire, courses, loyer personnel), sinon null si incertain.\n" +
  "Règles pour \"operations\" :\n" +
  "- date = date d'opération (à défaut date de valeur), format ISO AAAA-MM-JJ.\n" +
  "- libelle = libellé complet de l'opération (bénéficiaire, motif, référence).\n" +
  "- montant = montant signé en euros : NEGATIF pour un débit / retrait / paiement / prélèvement, " +
  "POSITIF pour un crédit / virement reçu / versement. Point décimal, pas de symbole ni de séparateur de milliers.\n";

const PROMPT_TAIL =
  "- affectation = FINALITÉ de l'opération (indépendante du type de compte) : " +
  '"activite" si la dépense/recette relève de l\'activité professionnelle (achats métier, ' +
  "fournisseurs, honoraires, ventes, matériel pro), \"prive\" si elle relève de la sphère " +
  "personnelle (courses, loisirs, restaurant perso, retrait), \"mixte\" si ambigu ou " +
  "partagé (téléphone, carburant, abonnement à usage mixte). Déduis-le du libellé.\n" +
  "- Ignore les soldes, totaux, sous-totaux, en-têtes et pieds de page : uniquement les opérations.\n" +
  "- Si aucune opération n'est lisible, renvoie \"operations\":[] (mais remplis \"compte\" si possible).";

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Clé ANTHROPIC_API_KEY absente de .env.local (côté serveur)." },
      { status: 500 }
    );
  }

  // Deux modes d'entrée (corps toujours minuscule → pas de limite 413) :
  //  - { image, mediaType } : UNE image de page déjà rendue côté client (mode
  //    rapide : le PDF est découpé en pages et lu page par page, en parallèle).
  //  - { url, name } : le fichier dans Storage, téléchargé ici (repli).
  let url = "";
  let name = "";
  let image = "";
  let mediaTypeIn = "";
  let categories: string[] = [];
  try {
    const body = (await req.json()) as {
      url?: string;
      name?: string;
      image?: string;
      mediaType?: string;
      categories?: string[];
    };
    categories = Array.isArray(body.categories)
      ? body.categories.filter((c) => typeof c === "string" && c.trim()).slice(0, 60)
      : [];
    url = typeof body.url === "string" ? body.url : "";
    name = typeof body.name === "string" ? body.name : "";
    image = typeof body.image === "string" ? body.image : "";
    mediaTypeIn = typeof body.mediaType === "string" ? body.mediaType : "";
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: any[] = [];

  if (image) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaTypeIn || "image/jpeg",
        data: image,
      },
    });
  } else if (url) {
    let buf: Buffer;
    let contentType = "";
    try {
      const r = await fetch(url);
      if (!r.ok) {
        return NextResponse.json(
          { error: `Téléchargement du fichier impossible (HTTP ${r.status}).` },
          { status: 502 }
        );
      }
      contentType = r.headers.get("content-type") || "";
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      return NextResponse.json(
        { error: "Téléchargement du fichier impossible : " + (e as Error).message },
        { status: 502 }
      );
    }
    const b64 = buf.toString("base64");
    const isPdf = /\.pdf$/i.test(name) || contentType.includes("application/pdf");
    if (isPdf) {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: b64 },
      });
    } else {
      const mediaType = contentType.startsWith("image/")
        ? contentType
        : /\.png$/i.test(name)
        ? "image/png"
        : /\.webp$/i.test(name)
        ? "image/webp"
        : "image/jpeg";
      content.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: b64 },
      });
    }
  } else {
    return NextResponse.json({ error: "Aucun fichier fourni." }, { status: 400 });
  }
  content.push({ type: "text", text: buildPrompt(categories) });

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
      categorie:
        typeof o.categorie === "string" && o.categorie.trim() ? o.categorie.trim() : null,
      affectation:
        o.affectation === "activite" || o.affectation === "prive" || o.affectation === "mixte"
          ? o.affectation
          : null,
    };
  });

  // stop_reason "max_tokens" = relevé trop long, réponse tronquée → on prévient.
  const truncated = data.stop_reason === "max_tokens";
  return NextResponse.json({ account, rows, truncated });
}
