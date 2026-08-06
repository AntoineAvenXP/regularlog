import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import {
  OWNER_UID,
  REGION,
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  ANTHROPIC_API_KEY,
} from "../config";
import { extractFromDocument, matchTransaction } from "../reconcile/ai";

const ATTACH_OK = /\.(pdf|png|jpe?g|gif|webp)$/i;

function safeKey(s: string): string {
  return s.replace(/[^\w.\-]/g, "_").slice(0, 200);
}

/**
 * Relève la boîte justificatifsregularlog@gmail.com (IMAP) toutes les heures.
 * Pour chaque pièce jointe exploitable : dépôt Storage → extraction IA →
 * justificatif → proposition de rapprochement (jamais de rattachement auto, §8).
 *
 * Idempotence + filet de sécurité : chaque pièce est marquée dans `emailPieces`
 * (clé déterministe). Un mail n'est marqué « lu » QUE si TOUTES ses pièces sont
 * enregistrées — sinon il est relu au prochain passage (rien n'est perdu).
 */
export const mailboxPoll = onSchedule(
  {
    schedule: "every 60 minutes",
    region: REGION,
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD, ANTHROPIC_API_KEY],
    maxInstances: 1,
    timeoutSeconds: 540,
  },
  async () => {
    const db = getFirestore();
    const bucket = getStorage().bucket();

    // Transactions pour l'appariement (une fois).
    const txSnap = await db
      .collection("transactions")
      .where("ownerUid", "==", OWNER_UID)
      .get();
    const txs = txSnap.docs.map((d) => ({
      id: d.id,
      montant: d.data().montant as number,
      dateOperation: (d.data().dateOperation as string) ?? "",
      libelleBrut: (d.data().libelleBrut as string) ?? "",
    }));

    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: GMAIL_USER.value(), pass: GMAIL_APP_PASSWORD.value() },
      logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = (await client.search({ seen: false }, { uid: true })) || [];
        for (const uid of uids) {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const msgKey = safeKey(parsed.messageId || `uid-${uid}`);
          const attachments = (parsed.attachments || []).filter(
            (a) => a.filename && ATTACH_OK.test(a.filename)
          );

          let failed = 0;
          for (const att of attachments) {
            const pieceKey = `${msgKey}__${safeKey(att.filename || "piece")}`;
            const markerRef = db.collection("emailPieces").doc(pieceKey);
            try {
              // Déjà traité (idempotence) ?
              if ((await markerRef.get()).exists) continue;

              const jRef = db.collection("justificatifs").doc();
              const path = `users/${OWNER_UID}/justificatifs/${jRef.id}/${safeKey(att.filename || "piece")}`;
              await bucket.file(path).save(att.content, {
                contentType: att.contentType || "application/octet-stream",
              });

              let ex = { date: null, montant: null, emetteur: null, numeroPiece: null } as Awaited<
                ReturnType<typeof extractFromDocument>
              >;
              try {
                ex = await extractFromDocument(att.content, att.contentType || "", att.filename || "");
              } catch {
                /* extraction échouée → file manuelle, champs nuls */
              }

              await jRef.set({
                ownerUid: OWNER_UID,
                storagePath: path,
                nomOrigine: att.filename,
                source: "email",
                date: ex.date,
                emetteur: ex.emetteur,
                montant: ex.montant,
                numeroPiece: ex.numeroPiece,
                transactionIds: [],
                statut: "en_attente_validation",
                notes: parsed.subject ? `Mail : ${parsed.subject}` : null,
                createdAt: FieldValue.serverTimestamp(),
              });

              const m = matchTransaction(ex, txs);
              if (m) {
                await db.collection("reconciliations").add({
                  ownerUid: OWNER_UID,
                  justificatifId: jRef.id,
                  transactionId: m.transactionId,
                  score: m.score,
                  motif: m.motif,
                  statut: "en_attente",
                  createdAt: FieldValue.serverTimestamp(),
                });
              }

              await markerRef.set({
                ownerUid: OWNER_UID,
                justificatifId: jRef.id,
                createdAt: FieldValue.serverTimestamp(),
              });
            } catch (e) {
              failed++;
              console.error("[mailboxPoll] pièce en échec", pieceKey, e);
            }
          }

          // Marque « lu » seulement si tout est enregistré (sinon relu plus tard).
          if (failed === 0) {
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }
);
