import { defineSecret } from "firebase-functions/params";

export const REGION = "europe-west1";

/**
 * Outil mono-utilisateur : uid Firebase du propriétaire (celui de tous les
 * documents ownerUid). Ce n'est pas un secret, juste l'ancrage des CF planifiées
 * (qui n'ont pas de contexte d'auth). À ajuster si le compte change.
 */
export const OWNER_UID = "ht4whE1xz8bKjK9AYxNOHhMqzBt1";

// Secrets tiers — valeurs dans Secret Manager, jamais dans le code.
export const BRIDGE_CLIENT_ID = defineSecret("BRIDGE_CLIENT_ID");
export const BRIDGE_CLIENT_SECRET = defineSecret("BRIDGE_CLIENT_SECRET");
export const GMAIL_USER = defineSecret("GMAIL_USER");
export const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
export const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
