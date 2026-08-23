"use client";

import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { Table2, FileSpreadsheet } from "lucide-react";
import { SectionHeader } from "@/components/PageHeader";
import { COL, createOwned, listOwned, updateOwned } from "@/lib/db";
import { fingerprint, fmtAmount, parseAmount, parseDate } from "@/lib/parsing";
import { writeImport } from "@/lib/importWrite";
import type { BankAccount, ColumnMapping, Entity } from "@/lib/types";

type AmountMode = "single" | "debitcredit";

interface PreviewRow {
  dateOperation: string | null;
  dateValeur: string | null;
  libelle: string;
  montant: number | null;
  valid: boolean;
  reason: string;
  fp: string;
  dupExisting: boolean;
  dupBatch: boolean;
  include: boolean;
}

/**
 * Import d'un export tableur (CSV / Excel) avec mappage de colonnes mémorisé par
 * banque. Pour les relevés PDF/image, voir StatementImport (lecture IA).
 */
export default function TabularImport({
  entities,
  accounts,
  fpByAccount,
  onImported,
}: {
  entities: Entity[];
  accounts: BankAccount[];
  fpByAccount: Record<string, Set<string>>;
  onImported: (n: number) => void;
}) {
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [accountId, setAccountId] = useState("");
  const [fileName, setFileName] = useState("");
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [kind, setKind] = useState<"csv" | "excel">("csv");

  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [colDate, setColDate] = useState("");
  const [colDateValeur, setColDateValeur] = useState("");
  const [colLibelle, setColLibelle] = useState("");
  const [amountMode, setAmountMode] = useState<AmountMode>("single");
  const [colMontant, setColMontant] = useState("");
  const [colDebit, setColDebit] = useState("");
  const [colCredit, setColCredit] = useState("");
  const [decimal, setDecimal] = useState<"," | ".">(",");
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listOwned<ColumnMapping>(COL.mappings).then(setMappings).catch(() => {});
  }, []);

  const account = accounts.find((a) => a.id === accountId) || null;
  const existingFps = account ? fpByAccount[account.id] ?? new Set<string>() : new Set<string>();

  useEffect(() => {
    if (!account) return;
    const saved = mappings.find((m) => m.banque === account.banque);
    if (saved) {
      setColDate(saved.colDateOperation || "");
      setColDateValeur(saved.colDateValeur || "");
      setColLibelle(saved.colLibelle || "");
      if (saved.colMontant) {
        setAmountMode("single");
        setColMontant(saved.colMontant);
      } else if (saved.colDebit || saved.colCredit) {
        setAmountMode("debitcredit");
        setColDebit(saved.colDebit || "");
        setColCredit(saved.colCredit || "");
      }
      setDecimal(saved.decimalSeparator || ",");
    }
  }, [account, mappings]);

  function applyRows(all: string[][]) {
    if (all.length === 0) return;
    setHeaders(all[0]);
    setRows(all.slice(1));
  }

  async function onFile(f: File) {
    setFileName(f.name);
    setCurrentFile(f);
    setHeaders([]);
    setRows([]);
    setOverrides({});
    if (/\.csv$/i.test(f.name)) {
      setKind("csv");
      const text = await f.text();
      const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
      applyRows((parsed.data as string[][]).map((r) => r.map((c) => String(c ?? ""))));
    } else if (/\.xlsx?$/i.test(f.name)) {
      setKind("excel");
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const arr = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" });
      applyRows(arr.map((r) => r.map((c) => String(c ?? ""))));
    }
  }

  const colIndex = (h: string) => headers.indexOf(h);

  const preview: PreviewRow[] = useMemo(() => {
    if (!account || headers.length === 0) return [];
    const iDate = colIndex(colDate);
    const iDateV = colDateValeur ? colIndex(colDateValeur) : -1;
    const iLib = colIndex(colLibelle);
    const iMont = colMontant ? colIndex(colMontant) : -1;
    const iDeb = colDebit ? colIndex(colDebit) : -1;
    const iCred = colCredit ? colIndex(colCredit) : -1;
    const seen = new Set<string>();
    return rows.map((r): PreviewRow => {
      const dateOperation = iDate >= 0 ? parseDate(r[iDate]) : null;
      const dateValeur = iDateV >= 0 ? parseDate(r[iDateV]) : null;
      const libelle = iLib >= 0 ? (r[iLib] ?? "").trim() : "";
      let montant: number | null = null;
      if (amountMode === "single") montant = iMont >= 0 ? parseAmount(r[iMont], decimal) : null;
      else {
        const deb = iDeb >= 0 ? parseAmount(r[iDeb], decimal) : null;
        const cred = iCred >= 0 ? parseAmount(r[iCred], decimal) : null;
        if (deb != null || cred != null) montant = (cred ?? 0) - Math.abs(deb ?? 0);
      }
      let valid = true;
      let reason = "";
      if (!dateOperation) { valid = false; reason = "date illisible"; }
      else if (montant == null) { valid = false; reason = "montant illisible"; }
      else if (!libelle) { valid = false; reason = "libellé vide"; }
      const fp = valid ? fingerprint(account.id, dateOperation as string, montant as number, libelle) : "";
      const dupExisting = valid && existingFps.has(fp);
      const dupBatch = valid && seen.has(fp);
      if (valid) seen.add(fp);
      return { dateOperation, dateValeur, libelle, montant, valid, reason, fp, dupExisting, dupBatch, include: valid && !dupExisting && !dupBatch };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, headers, rows, colDate, colDateValeur, colLibelle, amountMode, colMontant, colDebit, colCredit, decimal, existingFps]);

  const included = (i: number) => (overrides[i] !== undefined ? overrides[i] : preview[i]?.include);

  async function saveMapping() {
    if (!account) return;
    const existing = mappings.find((m) => m.banque === account.banque);
    const payload = {
      banque: account.banque,
      colDateOperation: colDate,
      colDateValeur: colDateValeur || null,
      colLibelle,
      colMontant: amountMode === "single" ? colMontant : null,
      colDebit: amountMode === "debitcredit" ? colDebit : null,
      colCredit: amountMode === "debitcredit" ? colCredit : null,
      decimalSeparator: decimal,
    };
    if (existing) await updateOwned(COL.mappings, existing.id, payload);
    else await createOwned(COL.mappings, payload);
  }

  async function runImport() {
    if (!account) return;
    setBusy(true);
    try {
      await saveMapping();
      const drafts = preview
        .map((p, i) => ({ p, i }))
        .filter(({ p, i }) => p.valid && included(i))
        .map(({ p }) => ({
          dateOperation: p.dateOperation as string,
          dateValeur: p.dateValeur,
          libelle: p.libelle,
          montant: p.montant as number,
          fp: p.fp,
        }));
      const n = await writeImport({
        account,
        drafts,
        origine: kind === "excel" ? "import_excel" : "import_csv",
        aVerifier: false,
        importKind: kind,
        fileName,
        file: currentFile,
      });
      setHeaders([]);
      setRows([]);
      setOverrides({});
      setFileName("");
      setCurrentFile(null);
      onImported(n);
    } finally {
      setBusy(false);
    }
  }

  const accLabel = (a: BankAccount) => {
    const en = entities.find((e) => e.id === a.entityId)?.denomination ?? "—";
    return `${a.libelle} · ${a.banque} · ${en}`;
  };

  return (
    <section className="card">
      <SectionHeader icon={Table2} title="Export tableur (CSV / Excel)" />
      <p className="muted" style={{ marginTop: 0, marginBottom: 16, fontSize: 12.5 }}>
        Pour les exports de colonnes fournis par ta banque. Le mappage est
        mémorisé par banque et reproposé aux prochains imports.
      </p>

      <div className="row" style={{ marginBottom: headers.length ? 16 : 0 }}>
        <div className="field" style={{ minWidth: 320 }}>
          <label>Compte bancaire de destination</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">— choisir —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{accLabel(a)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Fichier CSV / XLS / XLSX</label>
          <label className={`btn secondary${!accountId ? " disabled" : ""}`} style={{ alignSelf: "flex-start" }}>
            <FileSpreadsheet />
            Choisir un fichier
            <input
              type="file"
              accept=".csv,.xls,.xlsx"
              disabled={!accountId}
              style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
          </label>
          {fileName && <span className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{fileName}</span>}
        </div>
      </div>
      {accounts.length === 0 && (
        <p className="muted" style={{ marginTop: 8 }}>
          Crée d&apos;abord une entité et un compte dans <strong>Paramètres</strong>.
        </p>
      )}

      {headers.length > 0 && account && (
        <>
          <div style={{ marginTop: 4, marginBottom: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
            <div className="row">
              <Selector label="Date d'opération *" value={colDate} onChange={setColDate} headers={headers} />
              <Selector label="Date de valeur" value={colDateValeur} onChange={setColDateValeur} headers={headers} allowEmpty />
              <Selector label="Libellé *" value={colLibelle} onChange={setColLibelle} headers={headers} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <div className="field">
                <label>Montant</label>
                <select value={amountMode} onChange={(e) => setAmountMode(e.target.value as AmountMode)}>
                  <option value="single">Colonne unique signée</option>
                  <option value="debitcredit">Débit / Crédit séparés</option>
                </select>
              </div>
              {amountMode === "single" ? (
                <Selector label="Colonne montant *" value={colMontant} onChange={setColMontant} headers={headers} />
              ) : (
                <>
                  <Selector label="Colonne débit" value={colDebit} onChange={setColDebit} headers={headers} allowEmpty />
                  <Selector label="Colonne crédit" value={colCredit} onChange={setColCredit} headers={headers} allowEmpty />
                </>
              )}
              <div className="field">
                <label>Séparateur décimal</label>
                <select value={decimal} onChange={(e) => setDecimal(e.target.value as "," | ".")}>
                  <option value=",">virgule (1 234,56)</option>
                  <option value=".">point (1,234.56)</option>
                </select>
              </div>
            </div>
          </div>

          <div className="toolbar">
            <span><strong>{preview.filter((p) => p.valid).length}</strong> valides</span>
            <span style={{ color: "var(--amber)" }}><strong>{preview.filter((p) => p.dupExisting || p.dupBatch).length}</strong> doublons présumés</span>
            <span style={{ color: "var(--red)" }}><strong>{preview.filter((p) => !p.valid).length}</strong> illisibles</span>
            <span style={{ marginLeft: "auto" }}>À importer : <strong>{preview.filter((_, i) => included(i) && preview[i].valid).length}</strong></span>
            <button className="btn" disabled={busy} onClick={runImport}>{busy ? "Import…" : "Valider l'import"}</button>
          </div>

          <div style={{ overflowX: "auto", maxHeight: 460, overflowY: "auto" }}>
            <table className="grid">
              <thead>
                <tr><th>Import ?</th><th>Date</th><th>Libellé</th><th>Montant</th><th>État</th></tr>
              </thead>
              <tbody>
                {preview.slice(0, 500).map((p, i) => (
                  <tr key={i} style={{ opacity: p.valid ? 1 : 0.5 }}>
                    <td><input type="checkbox" disabled={!p.valid} checked={!!included(i)} onChange={(e) => setOverrides((o) => ({ ...o, [i]: e.target.checked }))} /></td>
                    <td>{p.dateOperation ?? "—"}</td>
                    <td style={{ whiteSpace: "normal", maxWidth: 380 }}>{p.libelle || "—"}</td>
                    <td style={{ color: (p.montant ?? 0) < 0 ? "var(--red)" : "var(--green)" }}>{p.montant != null ? fmtAmount(p.montant) : "—"}</td>
                    <td>
                      {!p.valid ? <span className="badge manquant">{p.reason}</span>
                        : p.dupExisting ? <span className="badge verif">doublon (déjà en base)</span>
                        : p.dupBatch ? <span className="badge verif">doublon (dans le fichier)</span>
                        : <span className="badge rattache">ok</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Selector({
  label,
  value,
  onChange,
  headers,
  allowEmpty,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  headers: string[];
  allowEmpty?: boolean;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allowEmpty ? "— aucune —" : "— choisir —"}</option>
        {headers.map((h, i) => (
          <option key={`${h}-${i}`} value={h}>{h || `(colonne ${i + 1})`}</option>
        ))}
      </select>
    </div>
  );
}
