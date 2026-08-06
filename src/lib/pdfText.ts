// Extraction de texte d'un PDF « texte » (non scanné), côté navigateur (pdf.js).
// Import dynamique : pdf.js touche au DOM/Worker → jamais au rendu serveur.

interface PdfItem {
  str: string;
  transform: number[];
}

/** Regroupe les fragments de texte d'une page en lignes (par coordonnée Y). */
function groupLines(items: PdfItem[]): string[] {
  const byY = new Map<number, { x: number; s: string }[]>();
  for (const it of items) {
    if (!it.str) continue;
    const y = Math.round(it.transform[5]);
    const x = it.transform[4];
    const arr = byY.get(y);
    if (arr) arr.push({ x, s: it.str });
    else byY.set(y, [{ x, s: it.str }]);
  }
  return [...byY.entries()]
    .sort((a, b) => b[0] - a[0]) // haut de page → bas
    .map(([, frags]) =>
      frags
        .sort((a, b) => a.x - b.x)
        .map((f) => f.s)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
}

export async function extractPdfText(file: File): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  // Worker servi par unpkg à la version exacte (outil perso, réseau dispo).
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const out: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    out.push(...groupLines(content.items as unknown as PdfItem[]));
  }
  return out.join("\n");
}
