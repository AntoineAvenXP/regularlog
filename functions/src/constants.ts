// Constantes SANS secret (région, uid propriétaire). Séparées de config.ts pour
// qu'une fonction puisse les utiliser sans déclencher la déclaration des secrets
// tiers (Bridge/Gmail) — Firebase exige tout secret défini dans le codebase chargé.

export const REGION = "europe-west1";

/** uid Firebase du propriétaire (outil mono-utilisateur). */
export const OWNER_UID = "ht4whE1xz8bKjK9AYxNOHhMqzBt1";
