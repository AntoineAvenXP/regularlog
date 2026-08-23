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
import { COL, createOwned, currentUid, updateOwned } from "./db";
import { importPath, uploadFile } from "./storage";
import type {
  BankAccount,
  ImportKind,
  Transaction,
  TransactionOrigin,
} from "./types";

/** Une transaction prête à écrire (déjà validée / dédupliquée en amont). */
export interface TxDraft {
  dateOperation: string;
  dateValeur: string | null;
  libelle: string;
  montant: number;
  fp: string;
}

export interface WriteImportParams {
  account: BankAccount;
  drafts: TxDraft[];
  origine: TransactionOrigin;
  aVerifier: boolean;
  importKind: ImportKind;
  fileName: string;
  file?: File | null;
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
 * Écrit un import complet. Retourne le nombre de transactions écrites.
 * Ne fait AUCUNE déduplication : l'appelant filtre en amont (aperçu/revue).
 */
export async function writeImport(params: WriteImportParams): Promise<number> {
  const { account, drafts, origine, aVerifier, importKind, fileName, file } =
    params;

  const importId = await createOwned(COL.imports, {
    kind: importKind,
    banque: account.banque,
    bankAccountId: account.id,
    sourceStoragePath: null,
    nomFichier: fileName,
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
        codeSuggere: null,
        codeValide: null,
        categorie: null,
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
  return drafts.length;
}
