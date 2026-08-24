import { NextRequest, NextResponse } from "next/server";

// Extraction IA d'un relevé bancaire (PDF ou image) → lignes structurées.
// Tourne côté SERVEUR (Node) : la clé Anthropic reste dans .env.local et n'est
// JAMAIS exposée au navigateur. Aucune dépendance à Cloud Functions / facturation
// Google — c'est l'API Anthropic qui est facturée (compte Anthropic).
export const runtime = "nodejs";
// Une page à la fois (le PDF est découpé côté client) → appels courts et
// parallèles. 60 s est large et compatible tous plans Vercel.
export const maxDuration = 60;

// Sonnet 5 par défaut : bien meilleur que Haiku pour lire les scans + trier
// activité/privé, et surtout ASSEZ RAPIDE pour tenir dans la limite de durée
// d'une fonction Vercel (Opus dépasse et provoque des 504). Surchargeable via
// ANTHROPIC_MODEL (claude-opus-5 possible si le traitement passe côté serveur
// long, sinon garder Sonnet).
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

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

/** Nettoie un fragment JSON (fences markdown, virgules traînantes). */
function cleanJson(s: string): string {
  return s.replace(/```(?:json)?/gi, "").replace(/,\s*([}\]])/g, "$1");
}

/** Extrait un objet {...} équilibré à partir de l'accolade ouvrante `start`. */
function balanced(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Récupération tolérante quand le JSON est tronqué (réponse coupée) : on
 * extrait le bloc "compte" équilibré + chaque objet d'opération COMPLET.
 */
function salvage(text: string): { compte: unknown; operations: unknown[] } {
  let compte: unknown = null;
  const ci = text.search(/"compte"\s*:\s*\{/);
  if (ci >= 0) {
    const braceIdx = text.indexOf("{", ci + 8);
    const block = braceIdx >= 0 ? balanced(text, braceIdx) : null;
    if (block) {
      try {
        compte = JSON.parse(cleanJson(block));
      } catch {
        /* bloc compte illisible */
      }
    }
  }
  const operations: unknown[] = [];
  const re = /\{[^{}]*"montant"[^{}]*\}/g;
  for (const m of text.matchAll(re)) {
    try {
      operations.push(JSON.parse(cleanJson(m[0])));
    } catch {
      /* opération partielle : ignorée */
    }
  }
  return { compte, operations };
}

const PROMPT_TAIL =
  "- affectation = FINALITÉ RÉELLE de l'opération, déduite d'une ANALYSE FINE du libellé " +
  "(bénéficiaire, mots-clés, type d'opération : VIR / PRLV / CB / retrait), " +
  "INDÉPENDAMMENT du type de compte :\n" +
  "    • \"activite\" = lié à l'ACTIVITÉ PROFESSIONNELLE : achats fournisseurs, matériel/logiciels pro, " +
  "honoraires versés ou reçus, ventes et encaissements clients, cotisations sociales pro " +
  "(URSSAF, RSI, retraite), TVA, frais bancaires du compte pro, loyer d'un local, sous-traitance.\n" +
  "    • \"prive\" = SPHÈRE PERSONNELLE : courses, restaurants perso, loisirs, santé, loyer d'habitation, " +
  "RETRAITS d'espèces, ÉPARGNE, et surtout les VIREMENTS VERS UN COMPTE PERSONNEL du dirigeant " +
  "(Nickel, Revolut, Boursorama, N26, Livret A, PEL, compte joint) : ces virements sont du SALAIRE / " +
  "de la rémunération ou de l'épargne — ce N'EST PAS de l'activité. Salaires reçus, allocations, " +
  "remboursements santé, pensions = prive.\n" +
  "    • \"mixte\" = réellement partagé ou ambigu : téléphone, internet, carburant, véhicule, " +
  "abonnements pouvant servir aux deux usages.\n" +
  "  Analyse en profondeur : un NOM DE PERSONNE (prénom + nom) en bénéficiaire d'un virement est " +
  "généralement privé (salaire/perso) ; un NOM DE SOCIÉTÉ ou d'enseigne B2B est généralement activité. " +
  "En cas de doute réel entre activite et prive, choisis \"mixte\" plutôt que de deviner.\n" +
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
        max_tokens: 16000,
        messages: [{ role: "user", content }],
      }),
      // Garde-fou : on coupe avant la limite Vercel pour renvoyer une erreur
      // propre (récupérable par « Réessayer ») au lieu d'un 504 brut.
      signal: AbortSignal.timeout(55000),
    });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError"
      ? "L'IA a mis trop de temps sur cette page — réessaie."
      : "Appel Anthropic impossible : " + (e as Error).message;
    return NextResponse.json({ error: msg }, { status: 504 });
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

  // Parse robuste : objet {compte, operations}, sinon tableau nu, sinon
  // récupération tolérante des opérations complètes si la réponse est tronquée.
  let parsed: unknown = null;
  const objSlice = text.match(/\{[\s\S]*\}/)?.[0];
  if (objSlice) {
    try {
      parsed = JSON.parse(cleanJson(objSlice));
    } catch {
      /* on tentera le repli */
    }
  }
  if (parsed == null) {
    const arrSlice = text.match(/\[[\s\S]*\]/)?.[0];
    if (arrSlice) {
      try {
        parsed = JSON.parse(cleanJson(arrSlice));
      } catch {
        /* on tentera le salvage */
      }
    }
  }
  if (parsed == null) {
    const s = salvage(text);
    if (s.operations.length > 0 || s.compte) parsed = { compte: s.compte, operations: s.operations };
  }
  if (parsed == null) {
    return NextResponse.json(
      { error: "Réponse IA illisible.", raw: text.slice(0, 300) },
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
