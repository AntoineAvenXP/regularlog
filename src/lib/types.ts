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

/** Usage d'une transaction : professionnel ou personnel (reconstitution). */
export type Usage = "pro" | "perso";

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
  usage?: Usage | null; // override pro/perso ; si absent, déduit de l'entité
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
  nbLignes: number;
  createdAt?: unknown;
}
