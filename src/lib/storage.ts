import {
  ref,
  uploadBytes,
  getDownloadURL,
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

export async function uploadFile(path: string, file: File): Promise<void> {
  await uploadBytes(ref(storage, path), file, { contentType: file.type || undefined });
}

export async function fileUrl(path: string): Promise<string> {
  return getDownloadURL(ref(storage, path));
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
