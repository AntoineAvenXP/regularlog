/**
 * Lecture IA d'une page de relevé — Cloud Function (europe-west1) : pas de limite
 * de durée courte comme sur Vercel, donc on peut utiliser Opus. Une page = un
 * appel ; le client (statementExtract) orchestre les pages en parallèle.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import Anthropic from "@anthropic-ai/sdk";
import { OWNER_UID, REGION } from "../constants";

// Secret déclaré ICI (pas via config.ts) pour ne pas embarquer les secrets
// Bridge/Gmail lors d'un déploiement de cette seule fonction.
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const MODEL = "claude-opus-5";
const FALLBACK_MODEL = "claude-sonnet-5"; // si Opus indisponible/surchargé

const PROMPT_HEAD =
  "Ce document est un relevé de compte bancaire. Tu dois (1) identifier le compte " +
  "et (2) extraire TOUTES les lignes d'opération, sans en oublier ni en inventer.\n" +
  "Réponds UNIQUEMENT par un objet JSON strict, sans aucun texte autour, au format :\n" +
  '{"compte":{"banque":"texte|null","iban":"texte|null","titulaire":"texte|null","periode":"AAAA-MM|null","usage":"pro|perso|null"},' +
  '"operations":[{"date":"AAAA-MM-JJ","libelle":"texte","montant":nombre,"categorie":"texte|null","affectation":"activite|prive|mixte","code":"texte|null"}]}\n' +
  "IMPORTANT — plusieurs comptes possibles : un même document (ou une même page) " +
  "peut concerner PLUSIEURS comptes bancaires différents. Repère-les grâce à leur " +
  "NUMÉRO DE COMPTE / IBAN. Le champ \"compte\" doit décrire le compte auquel " +
  "appartiennent les opérations que tu renvoies pour CETTE page. Reporte TOUJOURS " +
  "le numéro/IBAN quand il est visible, même partiel : c'est lui qui distingue les comptes.\n" +
  "Règles pour \"compte\" :\n" +
  "- banque = nom de la banque émettrice (ex. Qonto, BNP Paribas, Crédit Agricole).\n" +
  "- iban = IBAN ou numéro de compte tel qu'imprimé (complet ou partiel), sinon null. Ne l'invente jamais.\n" +
  "- titulaire = nom du titulaire, sinon null.\n" +
  "- periode = mois principal du relevé au format AAAA-MM, sinon null.\n" +
  "- usage = \"pro\" si le compte est professionnel (société, SIRET/TVA, banque pro type Qonto/Shine, " +
  "opérations d'activité), \"perso\" si compte de particulier, sinon null.\n" +
  "Règles pour \"operations\" :\n" +
  "- date = date d'opération (à défaut date de valeur), format ISO AAAA-MM-JJ.\n" +
  "- libelle = libellé complet (bénéficiaire, motif, référence).\n" +
  "- montant = montant signé en euros : NEGATIF pour un débit / retrait / paiement / prélèvement, " +
  "POSITIF pour un crédit / virement reçu. Point décimal, pas de symbole ni de séparateur de milliers.\n";

const PROMPT_TAIL =
  "- affectation = FINALITÉ RÉELLE de l'opération, déduite d'une ANALYSE FINE du libellé " +
  "(bénéficiaire, mots-clés, type : VIR / PRLV / CB / retrait), INDÉPENDAMMENT du type de compte :\n" +
  "    • \"activite\" = ACTIVITÉ PROFESSIONNELLE : achats fournisseurs, matériel/logiciels pro, " +
  "honoraires versés ou reçus, ventes et encaissements clients, cotisations sociales pro " +
  "(URSSAF, RSI, retraite), TVA, frais bancaires du compte pro, loyer d'un local, sous-traitance.\n" +
  "    • \"prive\" = SPHÈRE PERSONNELLE : courses, restaurants perso, loisirs, santé, loyer d'habitation, " +
  "RETRAITS d'espèces, ÉPARGNE, et surtout les VIREMENTS VERS UN COMPTE PERSONNEL du dirigeant " +
  "(Nickel, Revolut, Boursorama, N26, Livret A, PEL, compte joint) : ce sont du SALAIRE / de la " +
  "rémunération ou de l'épargne — PAS de l'activité. Salaires reçus, allocations, remboursements " +
  "santé, pensions = prive.\n" +
  "    • \"mixte\" = réellement partagé ou ambigu : téléphone, internet, carburant, véhicule, abonnements mixtes.\n" +
  "  Analyse en profondeur : un NOM DE PERSONNE en bénéficiaire d'un virement est généralement privé " +
  "(salaire/perso) ; un NOM DE SOCIÉTÉ ou d'enseigne B2B est généralement activité. En cas de doute " +
  "réel entre activite et prive, choisis \"mixte\".\n" +
  "- code = code comptable français (PCG) SUGGÉRÉ pour l'opération, d'après le libellé. Exemples : " +
  "607 achats de marchandises, 606 fournitures/énergie, 611 sous-traitance, 613 locations, 616 assurances, " +
  "6226 honoraires, 625 déplacements, 626 télécom, 627 services bancaires, 641 rémunérations, 645 charges " +
  "sociales, 706 prestations de services, 707 ventes de marchandises, 44566 TVA déductible, 455 compte " +
  "courant d'associé. Propose le plus probable ; sinon null. C'est une SUGGESTION, révisable.\n" +
  "- Ignore les soldes, totaux, sous-totaux, en-têtes et pieds de page : uniquement les opérations.\n" +
  "- Si aucune opération n'est lisible, renvoie \"operations\":[] (mais remplis \"compte\" si possible).";

function buildPrompt(categories: string[]): string {
  const catRule =
    categories.length > 0
      ? "- categorie = LA catégorie la plus adaptée, choisie EXACTEMENT dans cette liste : [" +
        categories.join(", ") +
        "]. Si vraiment aucune ne convient, mets null.\n"
      : '- categorie = courte catégorie usuelle (ex. "Nourriture", "Énergie", "Transport", "Salaires"), sinon null.\n';
  return PROMPT_HEAD + catRule + PROMPT_TAIL;
}

function cleanJson(s: string): string {
  return s.replace(/```(?:json)?/gi, "").replace(/,\s*([}\]])/g, "$1");
}

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

interface DetectedAccount {
  banque: string | null;
  iban: string | null;
  titulaire: string | null;
  periode: string | null;
  usage: "pro" | "perso" | null;
}

function parseAi(text: string): { account: DetectedAccount | null; rows: unknown[] } {
  let parsed: unknown = null;
  const objSlice = text.match(/\{[\s\S]*\}/)?.[0];
  if (objSlice) {
    try {
      parsed = JSON.parse(cleanJson(objSlice));
    } catch {
      /* repli */
    }
  }
  if (parsed == null) {
    const s = salvage(text);
    if (s.operations.length > 0 || s.compte) parsed = { compte: s.compte, operations: s.operations };
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
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
      const u = str(c.usage)?.toLowerCase();
      account = {
        banque: str(c.banque),
        iban: str(c.iban),
        titulaire: str(c.titulaire),
        periode: str(c.periode),
        usage: u === "pro" || u === "perso" ? u : null,
      };
    }
  }
  const rows = rawRows.map((r) => {
    const o = (r || {}) as Record<string, unknown>;
    const m = o.montant;
    return {
      date: typeof o.date === "string" && o.date ? o.date : null,
      libelle: typeof o.libelle === "string" ? o.libelle : "",
      montant: m != null && m !== "" && !Number.isNaN(Number(m)) ? Number(m) : null,
      categorie: typeof o.categorie === "string" && o.categorie.trim() ? o.categorie.trim() : null,
      affectation:
        o.affectation === "activite" || o.affectation === "prive" || o.affectation === "mixte"
          ? o.affectation
          : null,
      code: typeof o.code === "string" && o.code.trim() ? o.code.trim() : null,
    };
  });
  return { account, rows };
}

export const extractStatement = onCall(
  {
    region: REGION,
    secrets: [ANTHROPIC_API_KEY],
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 10,
  },
  async (req) => {
    if (!req.auth || req.auth.uid !== OWNER_UID) {
      throw new HttpsError("permission-denied", "Interdit.");
    }
    const data = (req.data || {}) as {
      image?: string;
      mediaType?: string;
      categories?: string[];
    };
    if (!data.image) throw new HttpsError("invalid-argument", "Image manquante.");
    const categories = Array.isArray(data.categories)
      ? data.categories.filter((c) => typeof c === "string" && c.trim()).slice(0, 60)
      : [];

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    const content: unknown[] = [
      {
        type: "image",
        source: { type: "base64", media_type: data.mediaType || "image/jpeg", data: data.image },
      },
      { type: "text", text: buildPrompt(categories) },
    ];

    const call = (model: string) =>
      client.messages.create({
        model,
        max_tokens: 16000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: [{ role: "user", content: content as any }],
      });

    let msg;
    try {
      msg = await call(MODEL);
    } catch (e) {
      // Opus indisponible / surchargé → repli sur Sonnet (la CF n'a pas de limite courte).
      try {
        msg = await call(FALLBACK_MODEL);
      } catch (e2) {
        throw new HttpsError("internal", "IA indisponible : " + (e2 as Error).message);
      }
    }

    const text = msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const { account, rows } = parseAi(text);
    const truncated = msg.stop_reason === "max_tokens";
    return { account, rows, truncated };
  }
);
