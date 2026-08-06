// OCR gratuit côté navigateur (Tesseract.js) — pour PDF scannés / images.
// Lent mais gratuit (§4.1). Import dynamique (charge le worker à la demande).
// Toute ligne issue d'un OCR est marquée « à vérifier » en amont de l'écriture.

export async function ocrImage(
  file: Blob,
  onProgress?: (p: number) => void
): Promise<string> {
  const Tesseract = await import("tesseract.js");
  const { data } = await Tesseract.recognize(file, "fra", {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === "recognizing text" && onProgress) onProgress(m.progress);
    },
  });
  return data.text;
}
