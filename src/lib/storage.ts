import {
  ref,
  uploadBytes,
  getDownloadURL,
  getBytes,
  deleteObject,
} from "firebase/storage";
import { storage, auth } from "./firebase";

function uid(): string {
  const u = auth.currentUser;
  if (!u) throw new Error("Non authentifié.");
  return u.uid;
}

/** Chemin Storage d'un justificatif : users/{uid}/justificatifs/{id}/{fichier}. */
export function justifPath(justifId: string, filename: string): string {
  const safe = filename.replace(/[^\w.\-]/g, "_");
  return `users/${uid()}/justificatifs/${justifId}/${safe}`;
}

/** Chemin Storage du fichier source d'un import : users/{uid}/imports/{id}/{fichier}. */
export function importPath(importId: string, filename: string): string {
  const safe = filename.replace(/[^\w.\-]/g, "_");
  return `users/${uid()}/imports/${importId}/${safe}`;
}

/** Chemin Storage d'un document généré : users/{uid}/documents/{id}/{fichier}. */
export function documentPath(docId: string, filename: string): string {
  const safe = filename.replace(/[^\w.\-]/g, "_");
  return `users/${uid()}/documents/${docId}/${safe}`;
}

/** Chemin Storage d'un relevé importé : users/{uid}/statements/{id}/{fichier}. */
export function statementPath(statementId: string, filename: string): string {
  const safe = filename.replace(/[^\w.\-]/g, "_");
  return `users/${uid()}/statements/${statementId}/${safe}`;
}

/** Upload d'un Blob (PDF généré) au chemin donné. */
export async function uploadBlob(path: string, blob: Blob, contentType: string): Promise<void> {
  await uploadBytes(ref(storage, path), blob, { contentType });
}

export async function uploadFile(path: string, file: File): Promise<void> {
  await uploadBytes(ref(storage, path), file, { contentType: file.type || undefined });
}

export async function fileUrl(path: string): Promise<string> {
  return getDownloadURL(ref(storage, path));
}

/** Récupère les octets d'un fichier (pour l'archive ZIP). */
export async function getFileBytes(path: string): Promise<ArrayBuffer> {
  return getBytes(ref(storage, path));
}

export async function deleteFile(path: string): Promise<void> {
  try {
    await deleteObject(ref(storage, path));
  } catch {
    /* fichier déjà absent : on ignore */
  }
}

export function isImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
}
export function isPdf(name: string): boolean {
  return /\.pdf$/i.test(name);
}
