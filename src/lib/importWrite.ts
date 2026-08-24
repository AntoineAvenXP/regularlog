// Écriture d'un import (factorisée) — utilisée par le flux tableur (CSV/Excel)
// et par le flux relevés IA (PDF/image). Crée le lot d'import, conserve le
// fichier source dans Storage (§12), puis écrit les transactions par batchs.

import {
  writeBatch,
  doc,
  collection,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "./firebase";
import { COL, createOwned, currentUid, deleteOwned, updateOwned } from "./db";
import { importPath, uploadFile } from "./storage";
import type {
  Affectation,
  BankAccount,
  ImportKind,
  Transaction,
  TransactionOrigin,
  Usage,
} from "./types";

/** Une transaction prête à écrire (déjà validée / dédupliquée en amont). */
export interface TxDraft {
  dateOperation: string;
  dateValeur: string | null;
  libelle: string;
  montant: number;
  fp: string;
  categorie?: string | null;
  affectation?: Affectation | null;
  code?: string | null;
}

export interface WriteImportParams {
  account: BankAccount;
  drafts: TxDraft[];
  origine: TransactionOrigin;
  aVerifier: boolean;
  importKind: ImportKind;
  fileName: string;
  file?: File | null;
  fileHash?: string | null; // empreinte du fichier source (anti ré-upload)
  supersedeTxIds?: string[]; // transactions Bridge à supprimer (l'upload prime)
  usage?: Usage | null; // pro/perso détecté via le relevé (override par ligne)
}

/**
 * Empreinte SHA-256 du contenu d'un fichier. Sert à rejeter le ré-upload exact
 * d'un relevé déjà importé (avant tout appel IA).
 */
export async function hashFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Clé « faible » compte+date+montant (sans libellé) : identifie la même
 * opération entre deux sources dont les libellés diffèrent (relevé vs Bridge).
 */
export function weakKey(dateOperation: string, montant: number): string {
  return `${dateOperation}|${montant.toFixed(2)}`;
}

/** Conserve le fichier source dans Storage, renvoie son chemin (ou null). */
async function storeSource(
  importId: string,
  file: File | null | undefined
): Promise<string | null> {
  if (!file) return null;
  try {
    const path = importPath(importId, file.name);
    await uploadFile(path, file);
    return path;
  } catch {
    return null;
  }
}

/**
 * Écrit un import complet. Retourne l'id du lot d'import (pour pouvoir tout
 * supprimer plus tard) et le nombre de transactions écrites.
 * Ne fait AUCUNE déduplication : l'appelant filtre en amont (aperçu/revue).
 */
export async function writeImport(
  params: WriteImportParams
): Promise<{ importId: string; count: number }> {
  const {
    account,
    drafts,
    origine,
    aVerifier,
    importKind,
    fileName,
    file,
    fileHash,
    supersedeTxIds,
    usage,
  } = params;

  // L'upload prime : on retire d'abord les transactions Bridge en conflit.
  for (const id of supersedeTxIds ?? []) {
    try {
      await deleteOwned(COL.transactions, id);
    } catch {
      /* déjà supprimée : on ignore */
    }
  }

  const importId = await createOwned(COL.imports, {
    kind: importKind,
    banque: account.banque,
    bankAccountId: account.id,
    sourceStoragePath: null,
    nomFichier: fileName,
    fileHash: fileHash ?? null,
    nbLignes: drafts.length,
  });
  const sourcePath = await storeSource(importId, file);
  if (sourcePath)
    await updateOwned(COL.imports, importId, { sourceStoragePath: sourcePath });

  const uid = currentUid();
  for (let i = 0; i < drafts.length; i += 400) {
    const chunk = drafts.slice(i, i + 400);
    const batch = writeBatch(db);
    for (const p of chunk) {
      const ref = doc(collection(db, COL.transactions));
      const tx: Omit<Transaction, "id"> = {
        ownerUid: uid,
        bankAccountId: account.id,
        entityId: account.entityId,
        dateOperation: p.dateOperation,
        dateValeur: p.dateValeur,
        libelleBrut: p.libelle,
        montant: p.montant,
        bankOperationId: null,
        fingerprint: p.fp,
        codeSuggere: p.code ?? null,
        codeValide: null,
        categorie: p.categorie ?? null,
        affectation: p.affectation ?? null,
        usage: usage ?? null,
        justificatifStatus: "manquant",
        fluxInterne: false,
        transactionMiroirId: null,
        origine,
        aVerifier,
        notes: null,
        importId,
        createdAt: serverTimestamp(),
      };
      batch.set(ref, tx);
    }
    await batch.commit();
  }
  return { importId, count: drafts.length };
}
