/**
 * Cloud Functions Regularlog (projet regular-869b7).
 * Région europe-west1. TOUS les secrets tiers (Bridge, Anthropic, Gmail)
 * passent par Secret Manager — jamais dans le code ni dans le bundle client.
 *
 * Garde-fous coûts (§2) : chaque fonction fixe maxInstances ; les tâches
 * planifiées restent espacées (Bridge 1×/j, boîte mail 1×/h).
 *
 * Les exports T6 (Bridge) et T7 (boîte mail + IA) sont ajoutés ci-dessous une
 * fois les décisions/clés fournies.
 */

import { initializeApp } from "firebase-admin/app";

initializeApp();

// T6 — Bridge (agrégation bancaire)
export { bridgeConnect, bridgeListAccounts, bridgeSync, bridgeDailySync } from "./bridge/sync";
// T7 — Boîte mail + rapprochement IA
export { mailboxPoll } from "./mailbox/poll";
