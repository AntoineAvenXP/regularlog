// Génération du PDF « liste de transactions » : logo Regularlog, dessin
// décoratif, regroupement (catégorie / compte / mois) avec sous-totaux, totaux
// généraux, référence + empreinte d'intégrité, et mention de bas de page selon
// la provenance des transactions (agrégateur Bridge vs fichier fourni).

import type { BrandAssets } from "./brandAssets";
import type { DocCertification } from "./types";

export interface PdfRow {
  date: string;
  libelle: string;
  categorie: string;
  compte: string;
  source: string;
  montant: number;
  groupKey: string;
}

export interface PdfReportParams {
  titre: string;
  reference: string;
  generatedAtLabel: string;
  filterSummary: { label: string; value: string }[];
  groupByLabel: string;
  rows: PdfRow[];
  totals: { nb: number; debit: number; credit: number; net: number };
  certification: DocCertification;
  integrity: string;
  assets: BrandAssets;
}

const GREEN: [number, number, number] = [47, 138, 74];
const DARK: [number, number, number] = [12, 35, 40];
const MUTED: [number, number, number] = [123, 136, 136];
const RED: [number, number, number] = [200, 38, 38];
const LIGHT: [number, number, number] = [246, 248, 246];
const ACCENT: [number, number, number] = [233, 242, 226];

const CERT_TEXT: Record<DocCertification, string> = {
  bridge:
    "Certification : toutes les transactions de ce document proviennent d'un agrégateur bancaire agréé (connexion Bridge).",
  upload:
    "Avertissement : certaines transactions de ce document proviennent d'un fichier de relevé fourni par l'utilisateur (import PDF / tableur).",
  manuel:
    "Avertissement : certaines transactions de ce document ont été saisies ou vérifiées manuellement par l'utilisateur.",
};

const eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const money = (n: number) => eur.format(n);

export async function generateTransactionsPdf(p: PdfReportParams): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;

  // -------- En-tête --------
  if (p.assets.fan) {
    try {
      doc.addImage(p.assets.fan, "PNG", pageW - 58, 9, 46, 23);
    } catch {
      /* décor optionnel */
    }
  }
  if (p.assets.logo) {
    try {
      doc.addImage(p.assets.logo, "PNG", margin, 12, 16, 16);
    } catch {
      /* logo optionnel */
    }
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(...DARK);
  doc.text(p.titre, margin + 21, 19);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...MUTED);
  doc.text(`Réf. ${p.reference}  ·  ${p.generatedAtLabel}`, margin + 21, 25);
  doc.setDrawColor(...ACCENT);
  doc.setLineWidth(0.4);
  doc.line(margin, 33, pageW - margin, 33);

  // -------- Bloc de périmètre (filtres) --------
  let y = 39;
  doc.setFontSize(9);
  const colW = (pageW - 2 * margin) / 2;
  p.filterSummary.forEach((f, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = margin + col * colW;
    const yy = y + row * 5.2;
    doc.setTextColor(...MUTED);
    doc.setFont("helvetica", "bold");
    doc.text(`${f.label} :`, x, yy);
    const labelW = doc.getTextWidth(`${f.label} : `);
    doc.setTextColor(...DARK);
    doc.setFont("helvetica", "normal");
    doc.text(f.value, x + labelW, yy);
  });
  const summaryRows = Math.ceil(p.filterSummary.length / 2);
  y = y + summaryRows * 5.2 + 3;

  // -------- Corps : regroupement + sous-totaux --------
  const groups = new Map<string, PdfRow[]>();
  for (const r of p.rows) {
    if (!groups.has(r.groupKey)) groups.set(r.groupKey, []);
    groups.get(r.groupKey)!.push(r);
  }

  type Cell =
    | string
    | { content: string; colSpan?: number; styles?: Record<string, unknown> };
  const body: Cell[][] = [];
  for (const [key, rows] of groups) {
    body.push([
      {
        content: `${p.groupByLabel} : ${key}`,
        colSpan: 5,
        styles: { fillColor: ACCENT, textColor: DARK, fontStyle: "bold" },
      },
    ]);
    let sub = 0;
    for (const r of rows) {
      sub += r.montant;
      body.push([
        r.date,
        r.libelle,
        r.source,
        r.categorie,
        {
          content: money(r.montant),
          styles: { halign: "right", textColor: r.montant < 0 ? RED : DARK },
        },
      ]);
    }
    body.push([
      {
        content: "Sous-total",
        colSpan: 4,
        styles: { halign: "right", fontStyle: "bold", textColor: MUTED },
      },
      {
        content: money(sub),
        styles: { halign: "right", fontStyle: "bold", textColor: sub < 0 ? RED : DARK },
      },
    ]);
  }

  const certText = CERT_TEXT[p.certification];

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin, bottom: 26 },
    head: [["Date", "Libellé", "Source", "Catégorie", "Montant"]],
    body: body as never,
    styles: { fontSize: 8, cellPadding: 1.6, textColor: DARK, lineColor: [230, 235, 231], lineWidth: 0.1 },
    headStyles: { fillColor: DARK, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 8 },
    alternateRowStyles: { fillColor: [250, 251, 250] },
    columnStyles: {
      0: { cellWidth: 20 },
      2: { cellWidth: 26 },
      3: { cellWidth: 30 },
      4: { cellWidth: 24, halign: "right" },
    },
    didDrawPage: () => {
      // Pied de page : mention de certification + intégrité + éditeur.
      const fy = pageH - 20;
      doc.setDrawColor(...ACCENT);
      doc.setLineWidth(0.4);
      doc.line(margin, fy, pageW - margin, fy);
      doc.setFontSize(7.5);
      const certColor = p.certification === "bridge" ? GREEN : MUTED;
      doc.setTextColor(...certColor);
      doc.setFont("helvetica", p.certification === "bridge" ? "bold" : "normal");
      const wrapped = doc.splitTextToSize(certText, pageW - 2 * margin);
      doc.text(wrapped, margin, fy + 4);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...MUTED);
      doc.setFontSize(6.8);
      doc.text(
        `Document généré par Regularlog — non contractuel.  Empreinte d'intégrité : ${p.integrity}`,
        margin,
        pageH - 8
      );
    },
  });

  // -------- Totaux généraux --------
  // @ts-expect-error lastAutoTable est ajouté par le plugin autotable
  let finalY: number = doc.lastAutoTable?.finalY ?? y;
  if (finalY > pageH - 55) {
    doc.addPage();
    finalY = 20;
  }
  const boxY = finalY + 6;
  doc.setFillColor(...LIGHT);
  doc.setDrawColor(...ACCENT);
  doc.roundedRect(margin, boxY, pageW - 2 * margin, 22, 2, 2, "FD");
  doc.setFontSize(9);
  const tItems: [string, string][] = [
    ["Transactions", String(p.totals.nb)],
    ["Total débits", money(p.totals.debit)],
    ["Total crédits", money(p.totals.credit)],
    ["Solde net", money(p.totals.net)],
  ];
  const tW = (pageW - 2 * margin) / 4;
  tItems.forEach(([label, val], i) => {
    const x = margin + i * tW + 4;
    doc.setTextColor(...MUTED);
    doc.setFont("helvetica", "normal");
    doc.text(label, x, boxY + 8);
    doc.setTextColor(...DARK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(val, x, boxY + 16);
    doc.setFontSize(9);
  });

  // -------- Numérotation des pages --------
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.setTextColor(...MUTED);
    doc.text(`Page ${i} / ${total}`, pageW - margin, pageH - 8, { align: "right" });
  }

  return doc.output("blob");
}
