"use client";

import { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import Shell from "@/components/Shell";
import { COL, listOwned } from "@/lib/db";
import type { BankAccount, Entity, Justificatif, Transaction } from "@/lib/types";
import { fmtAmount } from "@/lib/parsing";
import { getFileBytes } from "@/lib/storage";
import { useAuth } from "@/lib/auth";

export default function ExportPage() {
  return (
    <Shell>
      <ExportView />
    </Shell>
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function ExportView() {
  const { user } = useAuth();
  const [tx, setTx] = useState<Transaction[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [justifs, setJustifs] = useState<Justificatif[]>([]);
  const [loading, setLoading] = useState(true);

  const [fEntity, setFEntity] = useState("");
  const [fYear, setFYear] = useState("");
  const [zipBusy, setZipBusy] = useState(false);
  const [zipProgress, setZipProgress] = useState(0);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [t, e, a, j] = await Promise.all([
        listOwned<Transaction>(COL.transactions),
        listOwned<Entity>(COL.entities),
        listOwned<BankAccount>(COL.accounts),
        listOwned<Justificatif>(COL.justificatifs),
      ]);
      setTx(t);
      setEntities(e);
      setAccounts(a);
      setJustifs(j);
      setLoading(false);
    })();
  }, [user]);

  const entName = (id: string) => entities.find((e) => e.id === id)?.denomination ?? "—";
  const accName = (id: string) => accounts.find((a) => a.id === id)?.libelle ?? "—";

  const years = useMemo(() => {
    const s = new Set<string>();
    for (const t of tx) {
      const y = (t.dateOperation || "").slice(0, 4);
      if (y) s.add(y);
    }
    return [...s].sort();
  }, [tx]);

  const filtered = useMemo(
    () =>
      tx.filter((t) => {
        if (fEntity && t.entityId !== fEntity) return false;
        if (fYear && !(t.dateOperation || "").startsWith(fYear)) return false;
        return true;
      }),
    [tx, fEntity, fYear]
  );

  function exportCsv() {
    const cols = ["date_operation", "date_valeur", "entite", "compte", "libelle", "montant", "code_valide", "code_suggere", "categorie", "statut_justificatif", "flux_interne", "origine", "a_verifier", "notes"];
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(";")];
    for (const t of filtered) {
      lines.push([t.dateOperation, t.dateValeur ?? "", entName(t.entityId), accName(t.bankAccountId), t.libelleBrut, String(t.montant).replace(".", ","), t.codeValide ?? "", t.codeSuggere ?? "", t.categorie ?? "", t.justificatifStatus, t.fluxInterne ? "oui" : "non", t.origine, t.aVerifier ? "oui" : "non", t.notes ?? ""].map(esc).join(";"));
    }
    download(new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" }), `regularlog-transactions-${today()}.csv`);
  }

  async function exportZip() {
    setZipBusy(true);
    setZipProgress(0);
    try {
      const ids = new Set(filtered.map((t) => t.id));
      const hasFilter = !!fEntity || !!fYear;
      const toExport = justifs.filter((j) =>
        hasFilter ? (j.transactionIds ?? []).some((id) => ids.has(id)) : true
      );
      const zip = new JSZip();
      let i = 0;
      for (const j of toExport) {
        if (j.storagePath) {
          try {
            const bytes = await getFileBytes(j.storagePath);
            const ext = j.nomOrigine.includes(".") ? j.nomOrigine.split(".").pop() : "bin";
            const txId = (j.transactionIds ?? [])[0] ?? "";
            const parts = [j.date || "", j.montant != null ? String(j.montant) : "", (j.emetteur || "").replace(/[^\w]+/g, "-"), txId].filter(Boolean);
            const base = parts.join("_") || j.id;
            zip.file(`${base}.${ext}`, bytes);
          } catch {
            /* fichier illisible : on l'ignore, on ne bloque pas l'archive */
          }
        }
        setZipProgress(++i / Math.max(1, toExport.length));
      }
      const blob = await zip.generateAsync({ type: "blob" });
      download(blob, `regularlog-justificatifs-${today()}.zip`);
    } finally {
      setZipBusy(false);
    }
  }

  function exportReport() {
    const sansJustif = filtered.filter((t) => t.justificatifStatus === "manquant");
    const flux = filtered.filter((t) => t.fluxInterne);
    const byCode = new Map<string, { count: number; montant: number }>();
    for (const t of filtered) {
      const c = t.codeValide || "(non affecté)";
      const cur = byCode.get(c) ?? { count: 0, montant: 0 };
      cur.count += 1;
      cur.montant += t.montant;
      byCode.set(c, cur);
    }
    const scope = `${fEntity ? entName(fEntity) : "Toutes entités"} — ${fYear || "Tous exercices"}`;
    const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
    const money = (n: number) => n.toFixed(2).replace(".", ",") + " €";
    const esc = (s: string) => s.replace(/</g, "&lt;");

    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Regularlog — Rapport de synthèse</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;color:#0f172a;max-width:900px;margin:24px auto;padding:0 16px}
h1{font-size:22px}h2{font-size:16px;margin-top:28px;border-bottom:2px solid #e2e8f0;padding-bottom:4px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
th,td{border:1px solid #e2e8f0;padding:5px 8px;text-align:left}th{background:#f8fafc}
.muted{color:#64748b}
</style></head><body>
<h1>Regularlog — Rapport de synthèse</h1>
<p class="muted">Périmètre : ${esc(scope)} · Généré le ${today()}</p>

<h2>1. Transactions sans justificatif (${sansJustif.length})</h2>
<table><tr><th>Date</th><th>Compte</th><th>Libellé</th><th>Montant</th></tr>
${sansJustif.map((t) => row([t.dateOperation, esc(accName(t.bankAccountId)), esc(t.libelleBrut), money(t.montant)])).join("")}</table>

<h2>2. Flux internes (${flux.length})</h2>
<table><tr><th>Date</th><th>Compte</th><th>Libellé</th><th>Montant</th></tr>
${flux.map((t) => row([t.dateOperation, esc(accName(t.bankAccountId)), esc(t.libelleBrut), money(t.montant)])).join("")}</table>

<h2>3. Totaux par code comptable</h2>
<table><tr><th>Code</th><th>Nb</th><th>Total</th></tr>
${[...byCode.entries()].sort((a, b) => b[1].count - a[1].count).map(([c, v]) => row([esc(c), String(v.count), money(v.montant)])).join("")}</table>
</body></html>`;
    download(new Blob([html], { type: "text/html;charset=utf-8;" }), `regularlog-rapport-${today()}.html`);
  }

  if (loading) return <p className="muted">Chargement…</p>;

  return (
    <div>
      <h1 className="page">Export</h1>
      <p className="sub">Pour transmission à un cabinet sans accès à l&apos;outil</p>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="row">
          <div className="field">
            <label>Entité</label>
            <select value={fEntity} onChange={(e) => setFEntity(e.target.value)}>
              <option value="">Toutes</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.denomination}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Exercice</label>
            <select value={fYear} onChange={(e) => setFYear(e.target.value)}>
              <option value="">Tous</option>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <div style={{ alignSelf: "flex-end", color: "var(--muted)", fontSize: 13 }}>
            {filtered.length} transaction(s) dans le périmètre
          </div>
        </div>
      </div>

      <div className="row" style={{ gap: 16 }}>
        <ExportCard
          title="Transactions (CSV / Excel)"
          desc="Toutes les colonnes, filtrable par période et entité. Ouvrable dans Excel."
          action="Exporter le CSV"
          onClick={exportCsv}
        />
        <ExportCard
          title="Archive des justificatifs (ZIP)"
          desc="Fichiers nommés lisiblement : date, montant, émetteur, id de transaction."
          action={zipBusy ? `Préparation… ${Math.round(zipProgress * 100)} %` : "Générer le ZIP"}
          onClick={exportZip}
          disabled={zipBusy}
        />
        <ExportCard
          title="Rapport de synthèse (HTML)"
          desc="Sans justificatif, flux internes, totaux par code. Imprimable en PDF."
          action="Générer le rapport"
          onClick={exportReport}
        />
      </div>
    </div>
  );
}

function ExportCard({
  title,
  desc,
  action,
  onClick,
  disabled,
}: {
  title: string;
  desc: string;
  action: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 250, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontWeight: 700 }}>{title}</div>
      <div className="muted" style={{ fontSize: 13, flex: 1 }}>{desc}</div>
      <button className="btn" onClick={onClick} disabled={disabled}>{action}</button>
    </div>
  );
}
