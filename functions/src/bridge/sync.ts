import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  OWNER_UID,
  REGION,
  BRIDGE_CLIENT_ID,
  BRIDGE_CLIENT_SECRET,
} from "../config";
import {
  connectSession,
  getToken,
  listAccounts,
  listTransactions,
} from "./client";
import { fingerprint } from "../lib/fingerprint";

const bridgeSecrets = [BRIDGE_CLIENT_ID, BRIDGE_CLIENT_SECRET];

function assertOwner(uid: string | undefined) {
  if (uid !== OWNER_UID) throw new HttpsError("permission-denied", "Interdit.");
}

/** Synchronisation incrémentale : Bridge → transactions, dédup vs existant. */
async function doSync(): Promise<{ added: number; skipped: number }> {
  const db = getFirestore();
  const token = await getToken(OWNER_UID);

  // Comptes Regularlog reliés à un compte Bridge (bridgeAccountId).
  const accSnap = await db
    .collection("bankAccounts")
    .where("ownerUid", "==", OWNER_UID)
    .get();
  const accByBridgeId = new Map<string, { id: string; entityId: string }>();
  accSnap.forEach((d) => {
    const b = d.data().bridgeAccountId;
    if (b) accByBridgeId.set(String(b), { id: d.id, entityId: d.data().entityId });
  });

  // Empreintes + ids d'opération déjà présents (dédup contre imports manuels).
  // `uploadWeak` = clé compte+date+montant des transactions NON-Bridge (relevés
  // uploadés / saisies) : le relevé uploadé PRIME, Bridge ne recrée pas ces
  // opérations même si le libellé diffère.
  const txSnap = await db
    .collection("transactions")
    .where("ownerUid", "==", OWNER_UID)
    .get();
  const existingFp = new Set<string>();
  const existingBankOp = new Set<string>();
  const uploadWeak = new Set<string>();
  txSnap.forEach((d) => {
    const t = d.data();
    if (t.fingerprint) existingFp.add(t.fingerprint);
    if (t.bankOperationId) existingBankOp.add(String(t.bankOperationId));
    if (t.origine !== "bridge" && t.dateOperation != null && t.montant != null) {
      uploadWeak.add(`${t.bankAccountId}|${t.dateOperation}|${Number(t.montant).toFixed(2)}`);
    }
  });

  let added = 0;
  let skipped = 0;
  let batch = db.batch();
  let n = 0;

  // Transactions récupérées PAR compte Bridge rattaché.
  for (const [bridgeAccId, acc] of accByBridgeId) {
    const bridgeTx = await listTransactions(token, Number(bridgeAccId));
    for (const bt of bridgeTx) {
      const date = (bt.date ?? bt.booking_date ?? "").slice(0, 10);
      const montant = Number(bt.amount);
      const libelle = bt.clean_description ?? bt.provider_description ?? "";
      if (!date || !Number.isFinite(montant)) {
        skipped++;
        continue;
      }
      const bankOpId = String(bt.id);
      const fp = fingerprint(acc.id, date, montant, libelle);
      const weak = `${acc.id}|${date}|${montant.toFixed(2)}`;
      // Skip si déjà vu (id/empreinte) OU si un relevé uploadé couvre déjà
      // cette opération (compte+date+montant) : l'upload prime sur Bridge.
      if (existingBankOp.has(bankOpId) || existingFp.has(fp) || uploadWeak.has(weak)) {
        skipped++;
        continue;
      }
      const ref = db.collection("transactions").doc();
      batch.set(ref, {
        ownerUid: OWNER_UID,
        bankAccountId: acc.id,
        entityId: acc.entityId,
        dateOperation: date,
        dateValeur: null,
        libelleBrut: libelle,
        montant,
        bankOperationId: bankOpId,
        fingerprint: fp,
        codeSuggere: null,
        codeValide: null,
        categorie: null,
        justificatifStatus: "manquant",
        fluxInterne: false,
        transactionMiroirId: null,
        origine: "bridge",
        aVerifier: false,
        notes: null,
        importId: null,
        createdAt: FieldValue.serverTimestamp(),
      });
      existingFp.add(fp);
      existingBankOp.add(bankOpId);
      added++;
      n++;
      if (n >= 400) {
        await batch.commit();
        batch = db.batch();
        n = 0;
      }
    }
  }
  if (n > 0) await batch.commit();
  return { added, skipped };
}

/** Ouvre une session de connexion des banques (URL Bridge Connect). */
export const bridgeConnect = onCall(
  { region: REGION, secrets: bridgeSecrets, maxInstances: 3 },
  async (req) => {
    assertOwner(req.auth?.uid);
    const token = await getToken(OWNER_UID);
    const url = await connectSession(token);
    return { url };
  }
);

/** Liste les comptes Bridge (pour les rattacher aux comptes Regularlog). */
export const bridgeListAccounts = onCall(
  { region: REGION, secrets: bridgeSecrets, maxInstances: 3 },
  async (req) => {
    assertOwner(req.auth?.uid);
    const token = await getToken(OWNER_UID);
    const accounts = await listAccounts(token);
    return {
      accounts: accounts.map((a) => ({
        id: String(a.id),
        name: a.name,
        iban: a.iban ?? null,
      })),
    };
  }
);

/** Sync manuelle (bouton). */
export const bridgeSync = onCall(
  { region: REGION, secrets: bridgeSecrets, maxInstances: 3, timeoutSeconds: 300 },
  async (req) => {
    assertOwner(req.auth?.uid);
    return doSync();
  }
);

/** Sync automatique quotidienne (§4.2 : pas plus fréquente). */
export const bridgeDailySync = onSchedule(
  {
    schedule: "every day 05:00",
    timeZone: "Europe/Paris",
    region: REGION,
    secrets: bridgeSecrets,
    maxInstances: 1,
    timeoutSeconds: 540,
  },
  async () => {
    const r = await doSync();
    console.log("[bridgeDailySync]", r);
  }
);
