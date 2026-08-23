import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDocs,
  query,
  where,
  serverTimestamp,
  type QueryConstraint,
} from "firebase/firestore";
import { db, auth } from "./firebase";

/** Collections Firestore (toutes au niveau racine, scoping par ownerUid). */
export const COL = {
  entities: "entities",
  accounts: "bankAccounts",
  transactions: "transactions",
  justificatifs: "justificatifs",
  reconciliations: "reconciliations",
  mappings: "columnMappings",
  rules: "accountingRules",
  codes: "accountingCodes",
  categories: "categories",
  imports: "imports",
} as const;

export function currentUid(): string {
  const u = auth.currentUser;
  if (!u) throw new Error("Non authentifié.");
  return u.uid;
}

/** Liste les documents d'une collection appartenant à l'utilisateur courant. */
export async function listOwned<T>(
  col: string,
  ...constraints: QueryConstraint[]
): Promise<T[]> {
  const q = query(
    collection(db, col),
    where("ownerUid", "==", currentUid()),
    ...constraints
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T);
}

/** Crée un document en estampillant ownerUid + createdAt. */
export async function createOwned<T extends object>(
  col: string,
  data: T
): Promise<string> {
  const ref = await addDoc(collection(db, col), {
    ...data,
    ownerUid: currentUid(),
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateOwned(
  col: string,
  id: string,
  data: Record<string, unknown>
): Promise<void> {
  await updateDoc(doc(db, col, id), data);
}

export async function deleteOwned(col: string, id: string): Promise<void> {
  await deleteDoc(doc(db, col, id));
}
