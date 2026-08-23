// Lecture d'un relevé, RAPIDE et sans timeout : le fichier est découpé en pages
// (PDF via pdf.js → images ; image → redimensionnée), chaque page est lue par
// l'IA en PARALLÈLE (appels courts), puis les résultats sont fusionnés.

import {
  extractStatementImage,
  type AiExtractResult,
  type AiStatementRow,
} from "./aiExtract";

const CONCURRENCY = 4; // pages lues simultanément
const PDF_SCALE = 2; // netteté suffisante pour l'OCR
const IMG_MAX_DIM = 2200; // borne le poids d'une photo de relevé
const JPEG_QUALITY = 0.82;

function stripDataUrl(dataUrl: string): string {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image illisible"));
    img.src = src;
  });
}

/** Une image (photo/scan) → un seul « page » JPEG borné en dimension. */
async function imageFileToJpeg(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, IMG_MAX_DIM / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas indisponible");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return stripDataUrl(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Un PDF → une image JPEG par page (rendu pdf.js). */
async function pdfToJpegPages(file: File): Promise<string[]> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: PDF_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas indisponible");
    await page.render({ canvasContext: ctx, viewport }).promise;
    pages.push(stripDataUrl(canvas.toDataURL("image/jpeg", JPEG_QUALITY)));
  }
  return pages;
}

/** Découpe le relevé en images de page (base64 JPEG sans préfixe). */
export async function toPageImages(file: File): Promise<string[]> {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  if (isPdf) return pdfToJpegPages(file);
  return [await imageFileToJpeg(file)];
}

/**
 * Reconstruit un PDF LÉGER à partir des images de page déjà rendues. Sert de
 * copie persistée : bien plus petite qu'un scan brut → upload fiable.
 */
export async function buildStatementPdf(images: string[]): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doc: any = null;
  for (const b64 of images) {
    const dataUrl = `data:image/jpeg;base64,${b64}`;
    const img = await loadImage(dataUrl);
    const w = img.width;
    const h = img.height;
    const orient = w > h ? "landscape" : "portrait";
    if (!doc) doc = new jsPDF({ unit: "px", format: [w, h], orientation: orient });
    else doc.addPage([w, h], orient);
    doc.addImage(dataUrl, "JPEG", 0, 0, w, h);
  }
  if (!doc) return new Blob([], { type: "application/pdf" });
  return doc.output("blob") as Blob;
}

/** Exécute des tâches avec une concurrence bornée, en préservant l'ordre. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Lit des images de page déjà rendues : lecture IA parallèle → fusion.
 * `onProgress(done, total)` suit l'avancement des pages.
 */
export async function extractFromImages(
  pages: string[],
  onProgress?: (done: number, total: number) => void
): Promise<AiExtractResult> {
  const total = pages.length;
  let done = 0;

  const perPage = await mapLimit(pages, CONCURRENCY, async (img) => {
    const r = await extractStatementImage(img, "image/jpeg");
    done += 1;
    onProgress?.(done, total);
    return r;
  });

  // Fusion : compte détecté = 1re page qui porte une info ; opérations concaténées.
  const account =
    perPage.map((r) => r.account).find((a) => a && (a.banque || a.iban || a.titulaire)) ??
    perPage.find((r) => r.account)?.account ??
    null;
  const rows: AiStatementRow[] = perPage.flatMap((r) => r.rows);
  const truncated = perPage.some((r) => r.truncated);
  return { account, rows, truncated };
}
