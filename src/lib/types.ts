// Modèle de données Regularlog — cf. spécification §3.
// Chaque document porte `ownerUid` (verrou de sécurité, cf. firestore.rules).

export type EntityType = "societe" | "personnel";

/** Entité : une société ou la personne physique. */
export interface Entity {
  id: string;
  ownerUid: string;
  denomination: string;
  siren?: string | null;
  type: EntityType;
  createdAt?: unknown;
}

export type AccountSource = "import" | "bridge";

/** Compte bancaire rattaché à une entité. */
export interface BankAccount {
  id: string;
  ownerUid: string;
  entityId: string;
  banque: string;
  ibanPartiel?: string | null;
  libelle: string;
  source: AccountSource;
  bridgeAccountId?: string | null;
  usage?: Usage | null; // TYPE du compte : professionnel ou personnel
  createdAt?: unknown;
}

export type JustificatifStatus =
  | "manquant"
  | "rattache"
  | "perdu"
  | "sans_objet";

export type TransactionOrigin =
  | "import_csv"
  | "import_excel"
  | "import_pdf"
  | "import_ocr"
  | "bridge"
  | "saisie_manuelle";

/** Type d'un compte : professionnel ou personnel. */
export type Usage = "pro" | "perso";

/**
 * Affectation d'une OPÉRATION (finalité de la dépense/recette), déterminée par
 * l'IA — distincte du type de compte. Une dépense sur un compte pro peut être
 * privée, et inversement.
 */
export type Affectation = "activite" | "prive" | "mixte";

/** Transaction bancaire. */
export interface Transaction {
  id: string;
  ownerUid: string;
  bankAccountId: string;
  entityId: string; // dénormalisé pour filtrer
  dateOperation: string; // ISO yyyy-mm-dd
  dateValeur?: string | null;
  libelleBrut: string;
  montant: number; // signé
  bankOperationId?: string | null;
  fingerprint: string; // déduplication (§5)
  codeSuggere?: string | null; // suggéré ≠ validé (§6)
  codeValide?: string | null;
  categorie?: string | null; // catégorie usuelle (nourriture, énergie…)
  usage?: Usage | null; // hérité (ancien tag pro/perso par ligne) — remplacé par le type de compte
  affectation?: Affectation | null; // finalité de l'opération, déterminée par l'IA
  justificatifStatus: JustificatifStatus;
  fluxInterne: boolean; // §7
  transactionMiroirId?: string | null;
  origine: TransactionOrigin; // traçabilité (§12)
  aVerifier: boolean; // lignes issues d'OCR
  notes?: string | null;
  importId?: string | null; // pour annuler un import complet (§9)
  createdAt?: unknown;
}

export type JustificatifSource = "upload_manuel" | "email";
export type JustificatifValidation =
  | "en_attente_validation"
  | "valide"
  | "ecarte";

/** Justificatif (fichier dans Storage). Relation n–n avec les transactions. */
export interface Justificatif {
  id: string;
  ownerUid: string;
  storagePath: string;
  nomOrigine: string;
  source: JustificatifSource;
  date?: string | null;
  emetteur?: string | null;
  montant?: number | null;
  numeroPiece?: string | null;
  transactionIds: string[]; // un justif peut couvrir plusieurs transactions
  statut: JustificatifValidation;
  notes?: string | null;
  createdAt?: unknown;
}

export type ReconciliationStatus = "en_attente" | "valide" | "ecarte";

/** Proposition de rapprochement justificatif ↔ transaction (§3, §8). */
export interface ReconciliationProposal {
  id: string;
  ownerUid: string;
  justificatifId: string;
  transactionId: string;
  score: number;
  motif: string;
  statut: ReconciliationStatus;
  createdAt?: unknown;
}

/** Mappage de colonnes mémorisé par banque (§4.1). */
export interface ColumnMapping {
  id: string; // clé = banque normalisée
  ownerUid: string;
  banque: string;
  // Chaque champ = en-tête de colonne source (ou index) du fichier.
  colDateOperation: string;
  colDateValeur?: string | null;
  colLibelle: string;
  colMontant?: string | null; // colonne unique signée
  colDebit?: string | null; // ou débit/crédit séparés
  colCredit?: string | null;
  dateFormat?: string | null; // ex. "dd/MM/yyyy"
  decimalSeparator?: "," | ".";
  createdAt?: unknown;
}

/** Règle libellé → code comptable, éditable, enrichie à l'usage (§6). */
export interface AccountingRule {
  id: string;
  ownerUid: string;
  motif: string; // sous-chaîne recherchée dans le libellé normalisé
  code: string;
  libelleCode?: string | null;
  priorite?: number;
  createdAt?: unknown;
}

/** Catégorie usuelle éditable (nourriture, énergie, transport…). */
export interface Category {
  id: string;
  ownerUid: string;
  nom: string;
  ordre?: number;
  createdAt?: unknown;
}

/** Plan comptable simplifié, éditable — jamais codé en dur (§6). */
export interface AccountingCode {
  id: string;
  ownerUid: string;
  code: string;
  libelle: string;
  createdAt?: unknown;
}

/** Dossier de classement des documents générés (menu latéral). */
export interface Dossier {
  id: string;
  ownerUid: string;
  nom: string;
  createdAt?: unknown;
}

/** Provenance des transactions d'un document généré (mention de bas de page). */
export type DocCertification = "bridge" | "upload" | "manuel";

/** Document PDF généré (liste de transactions filtrées), classable en dossier. */
export interface GeneratedDocument {
  id: string;
  ownerUid: string;
  titre: string;
  reference: string; // ex. RL-20260823-4F2A
  storagePath: string;
  dossierId?: string | null;
  certification: DocCertification;
  groupBy: "categorie" | "compte" | "mois";
  filtres: {
    entityId?: string | null;
    bankAccountId?: string | null;
    categorie?: string | null;
    periodeStart?: string | null;
    periodeEnd?: string | null;
    usage?: "tout" | "pro" | "perso";
  };
  nbTransactions: number;
  totalDebit: number;
  totalCredit: number;
  integrity: string; // empreinte SHA-256 (courte) du contenu
  createdAt?: unknown;
}

/**
 * Relevé importé par IA, PERSISTANT (survit à la navigation). Le fichier est
 * conservé dans Storage dès le dépôt ; le traitement IA remplit le compte
 * détecté et les opérations, importées au fil de l'eau quand le compte est
 * rattaché.
 */
export type StatementStatus =
  | "processing" // en cours de lecture IA
  | "ready" // lu, en attente de rattachement d'un compte
  | "imported" // transactions écrites
  | "empty" // aucune opération détectée
  | "error";

export interface DetectedAccount {
  banque: string | null;
  iban: string | null;
  titulaire: string | null;
  periode: string | null;
  usage: Usage | null;
}

export type StatementRow = {
  date: string | null;
  libelle: string;
  montant: number | null;
  categorie?: string | null;
  affectation?: Affectation | null;
};

/**
 * Un compte détecté DANS un relevé. Un même fichier peut en contenir plusieurs
 * (numéros/IBAN différents) → chaque compte est rattaché et importé séparément.
 */
export interface StatementPart {
  key: string; // clé de regroupement (numéro de compte normalisé)
  detected: DetectedAccount | null;
  rows?: StatementRow[]; // opérations en attente d'import (vidées une fois importées)
  nbRows: number;
  resolvedAccountId?: string | null;
  importId?: string | null; // lot d'import lié → suppression en cascade
  nbImported?: number;
  imported?: boolean;
}

export interface Statement {
  id: string;
  ownerUid: string;
  fileName: string;
  fileHash?: string | null;
  storagePath: string;
  status: StatementStatus;
  error?: string | null;
  parts?: StatementPart[]; // un ou plusieurs comptes détectés dans le fichier
  nbRows?: number; // total opérations détectées (tous comptes)
  createdAt?: unknown;

  // --- Champs hérités (relevés créés avant le multi-comptes) — lecture seule.
  detected?: DetectedAccount | null;
  resolvedAccountId?: string | null;
  importId?: string | null;
  rows?: StatementRow[];
  nbImported?: number;
}

export type ImportKind = "csv" | "excel" | "pdf" | "ocr" | "bridge";

/** Lot d'import : historique + annulation d'un import complet (§9). */
export interface ImportBatch {
  id: string;
  ownerUid: string;
  kind: ImportKind;
  banque?: string | null;
  bankAccountId?: string | null;
  sourceStoragePath?: string | null; // fichier source conservé (§12)
  nomFichier?: string | null;
  fileHash?: string | null; // SHA-256 du fichier source : rejet des ré-uploads
  nbLignes: number;
  createdAt?: unknown;
}
