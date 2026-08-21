"use client";

import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  writeBatch,
  doc,
  collection,
  serverTimestamp,
} from "firebase/firestore";
import Shell from "@/components/Shell";
import { db } from "@/lib/firebase";
import {
  COL,
  createOwned,
  currentUid,
  listOwned,
  updateOwned,
} from "@/lib/db";
import type { BankAccount, ColumnMapping, Entity, Transaction } from "@/lib/types";
import { fingerprint, fmtAmount, parseAmount, parseDate } from "@/lib/parsing";
import { extractStatementAI } from "@/lib/aiExtract";
import { importPath, uploadFile } from "@/lib/storage";
import { useAuth } from "@/lib/auth";

type AmountMode = "single" | "debitcredit";
type SourceKind = "table" | "text" | null;

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

interface TextRow {
  date: string;
  libelle: string;
  montant: string;
  include: boolean;
}

export default function ImportsPage() {
  return (
    <Shell>
      <ImportWizard />
    </Shell>
  );
}

function ImportWizard() {
  const { user } = useAuth();
  const [entities, setEntities] = useState<Entity[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);

  const [accountId, setAccountId] = useState("");
  const [fileName, setFileName] = useState("");
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [sourceKind, setSourceKind] = useState<SourceKind>(null);
  const [kind, setKind] = useState<"csv" | "excel" | "pdf" | "ocr">("csv");

  // Flux tableur (CSV/Excel)
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

  // Flux texte (PDF/image) — extraction IA
  const [textRows, setTextRows] = useState<TextRow[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  const [existingFps, setExistingFps] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [e, a, m] = await Promise.all([
        listOwned<Entity>(COL.entities),
        listOwned<BankAccount>(COL.accounts),
        listOwned<ColumnMapping>(COL.mappings),
      ]);
      setEntities(e);
      setAccounts(a);
      setMappings(m);
    })();
  }, [user]);

  const account = accounts.find((a) => a.id === accountId) || null;

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

  function resetAll() {
    setHeaders([]);
    setRows([]);
    setTextRows([]);
    setSourceKind(null);
    setExtractError(null);
  }

  async function onFile(f: File) {
    setDone(null);
    setFileName(f.name);
    setCurrentFile(f);
    resetAll();

    if (/\.(csv)$/i.test(f.name)) {
      setKind("csv");
      setSourceKind("table");
      const text = await f.text();
      const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
      applyRows((parsed.data as string[][]).map((r) => r.map((c) => String(c ?? ""))));
    } else if (/\.xlsx?$/i.test(f.name)) {
      setKind("excel");
      setSourceKind("table");
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const arr = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" });
      applyRows(arr.map((r) => r.map((c) => String(c ?? ""))));
    } else if (/\.pdf$/i.test(f.name) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) {
      // PDF ou image → extraction IA (Claude lit le document et renvoie les lignes).
      const isPdf = /\.pdf$/i.test(f.name);
      setKind(isPdf ? "pdf" : "ocr");
      setSourceKind("text");
      setExtracting(true);
      setExtractError(null);
      try {
        const { rows: aiRows, truncated } = await extractStatementAI(f);
        setTextRows(
          aiRows.map((r) => ({
            date: r.date ?? "",
            libelle: r.libelle,
            montant: r.montant != null ? String(r.montant) : "",
            include: !!(r.date && r.montant != null && r.libelle),
          }))
        );
        if (truncated) {
          setExtractError(
            "Relevé long : la fin a peut-être été tronquée. Vérifie les dernières lignes (ou réimporte par pages)."
          );
        }
      } catch (e) {
        setExtractError((e as Error).message);
      } finally {
        setExtracting(false);
      }
    }
  }

  function applyRows(all: string[][]) {
    if (all.length === 0) return;
    setHeaders(all[0]);
    setRows(all.slice(1));
  }

  useEffect(() => {
    if (!accountId) return;
    (async () => {
      const tx = await listOwned<Transaction>(COL.transactions);
      setExistingFps(
        new Set(tx.filter((t) => t.bankAccountId === accountId).map((t) => t.fingerprint))
      );
    })().catch(() => setExistingFps(new Set()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, done]);

  const colIndex = (h: string) => headers.indexOf(h);

  // ---- Aperçu tableur
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
  }, [account, headers, rows, colDate, colDateValeur, colLibelle, amountMode, colMontant, colDebit, colCredit, decimal, existingFps]);

  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
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

  /** Conserve le fichier source dans Storage et renvoie son chemin (§12). */
  async function storeSource(importId: string): Promise<string | null> {
    if (!currentFile) return null;
    try {
      const path = importPath(importId, currentFile.name);
      await uploadFile(path, currentFile);
      return path;
    } catch {
      return null;
    }
  }

  async function writeTx(
    list: { dateOperation: string; dateValeur: string | null; libelle: string; montant: number; fp: string }[],
    origine: Transaction["origine"],
    aVerifier: boolean,
    importKind: "csv" | "excel" | "pdf" | "ocr"
  ) {
    if (!account) return 0;
    const importId = await createOwned(COL.imports, {
      kind: importKind,
      banque: account.banque,
      bankAccountId: account.id,
      sourceStoragePath: null,
      nomFichier: fileName,
      nbLignes: list.length,
    });
    const sourcePath = await storeSource(importId);
    if (sourcePath) await updateOwned(COL.imports, importId, { sourceStoragePath: sourcePath });

    const uid = currentUid();
    for (let i = 0; i < list.length; i += 400) {
      const chunk = list.slice(i, i + 400);
      const batch = writeBatch(db);
      for (const p of chunk) {
        const ref = doc(collection(db, COL.transactions));
        batch.set(ref, {
          ownerUid: uid,
          bankAccountId: account.id,
          entityId: account.entityId,
          dateOperation: p.dateOperation,
          dateValeur: p.dateValeur,
          libelleBrut: p.libelle,
          montant: p.montant,
          bankOperationId: null,
          fingerprint: p.fp,
          codeSuggere: null,
          codeValide: null,
          categorie: null,
          justificatifStatus: "manquant",
          fluxInterne: false,
          transactionMiroirId: null,
          origine,
          aVerifier,
          notes: null,
          importId,
          createdAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }
    return list.length;
  }

  async function runImport() {
    if (!account) return;
    setBusy(true);
    try {
      await saveMapping();
      const list = preview
        .map((p, i) => ({ p, i }))
        .filter(({ p, i }) => p.valid && included(i))
        .map(({ p }) => ({
          dateOperation: p.dateOperation as string,
          dateValeur: p.dateValeur,
          libelle: p.libelle,
          montant: p.montant as number,
          fp: p.fp,
        }));
      const n = await writeTx(list, kind === "excel" ? "import_excel" : "import_csv", false, kind === "excel" ? "excel" : "csv");
      finishImport(n);
    } finally {
      setBusy(false);
    }
  }

  async function runTextImport() {
    if (!account) return;
    setBusy(true);
    try {
      const list = textRows
        .filter((r) => r.include)
        .map((r) => {
          const d = parseDate(r.date);
          const m = Number(String(r.montant).replace(/\s/g, "").replace(",", "."));
          if (!d || Number.isNaN(m) || !r.libelle.trim()) return null;
          return {
            dateOperation: d,
            dateValeur: null,
            libelle: r.libelle.trim(),
            montant: m,
            fp: fingerprint(account.id, d, m, r.libelle.trim()),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const origine = kind === "ocr" ? "import_ocr" : "import_pdf";
      const n = await writeTx(list, origine, true, kind === "ocr" ? "ocr" : "pdf");
      finishImport(n);
    } finally {
      setBusy(false);
    }
  }

  function finishImport(n: number) {
    setDone(`${n} transaction(s) importée(s)${n && kind === "ocr" ? " — marquées « à vérifier »" : ""}.`);
    setFileName("");
    setCurrentFile(null);
    setOverrides({});
    resetAll();
  }

  const accLabel = (a: BankAccount) => {
    const en = entities.find((e) => e.id === a.entityId)?.denomination ?? "—";
    return `${a.libelle} · ${a.banque} · ${en}`;
  };

  // Dédup pour l'aperçu texte.
  const textFps = useMemo(() => {
    if (!account) return [] as { dup: boolean; valid: boolean }[];
    const seen = new Set<string>();
    return textRows.map((r) => {
      const d = parseDate(r.date);
      const m = Number(String(r.montant).replace(/\s/g, "").replace(",", "."));
      const valid = !!(d && !Number.isNaN(m) && r.libelle.trim());
      if (!valid) return { dup: false, valid: false };
      const fp = fingerprint(account.id, d as string, m, r.libelle.trim());
      const dup = existingFps.has(fp) || seen.has(fp);
      seen.add(fp);
      return { dup, valid };
    });
  }, [textRows, account, existingFps]);

  return (
    <div>
      <h1 className="page">Imports</h1>
      <p className="sub">CSV / Excel / PDF / image — rien n&apos;est enregistré avant validation</p>

      {done && (
        <div className="card" style={{ borderColor: "var(--green)", color: "var(--green)", marginBottom: 16 }}>
          ✓ {done}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row">
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
            <label>Fichier (CSV, XLS, XLSX, PDF, JPEG, PNG)</label>
            <input
              type="file"
              accept=".csv,.xls,.xlsx,.pdf,image/*"
              disabled={!accountId}
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
          </div>
        </div>
        {accounts.length === 0 && (
          <p className="muted" style={{ marginTop: 8 }}>Crée d&apos;abord un compte dans <strong>Paramètres</strong>.</p>
        )}
        {extracting && (
          <p className="muted" style={{ marginTop: 8 }}>
            Lecture du relevé par l&apos;IA…
          </p>
        )}
        {extractError && (
          <p style={{ marginTop: 8, color: "var(--amber)" }}>{extractError}</p>
        )}
      </div>

      {/* ---- Flux tableur ---- */}
      {sourceKind === "table" && headers.length > 0 && account && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 15, marginTop: 0 }}>Mappage des colonnes</h2>
            <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
              Mémorisé pour « {account.banque} » et proposé aux prochains imports.
            </p>
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

      {/* ---- Flux texte (PDF/OCR) : écran de VÉRIFICATION éditable ---- */}
      {sourceKind === "text" && textRows.length > 0 && account && (
        <>
          <div className="card" style={{ marginBottom: 12, borderColor: "var(--amber)" }}>
            <strong>Écran de vérification</strong> — lignes extraites par l&apos;IA.
            Corrige avant d&apos;importer : elles seront marquées <span className="badge verif">à vérifier</span>.
            Montant négatif = débit.
          </div>
          <div className="toolbar">
            <span>À importer : <strong>{textRows.filter((r, i) => r.include && textFps[i]?.valid).length}</strong></span>
            <button className="btn" disabled={busy} onClick={runTextImport} style={{ marginLeft: "auto" }}>
              {busy ? "Import…" : "Valider l'import"}
            </button>
          </div>
          <div style={{ overflowX: "auto", maxHeight: 480, overflowY: "auto" }}>
            <table className="grid">
              <thead>
                <tr><th>Import ?</th><th>Date (AAAA-MM-JJ)</th><th>Libellé</th><th>Montant</th><th>État</th></tr>
              </thead>
              <tbody>
                {textRows.map((r, i) => {
                  const info = textFps[i] ?? { dup: false, valid: false };
                  const set = (patch: Partial<TextRow>) =>
                    setTextRows((prev) => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  return (
                    <tr key={i} style={{ opacity: info.valid ? 1 : 0.6 }}>
                      <td><input type="checkbox" checked={r.include} onChange={(e) => set({ include: e.target.checked })} /></td>
                      <td><input value={r.date} onChange={(e) => set({ date: e.target.value })} style={{ maxWidth: 110 }} placeholder="2024-01-15" /></td>
                      <td><input value={r.libelle} onChange={(e) => set({ libelle: e.target.value })} style={{ maxWidth: 340, width: 340 }} /></td>
                      <td><input value={r.montant} onChange={(e) => set({ montant: e.target.value })} style={{ maxWidth: 90 }} placeholder="-12,34" /></td>
                      <td>
                        {!info.valid ? <span className="badge manquant">à corriger</span>
                          : info.dup ? <span className="badge verif">doublon présumé</span>
                          : <span className="badge rattache">ok</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {sourceKind === "text" && !extracting && textRows.length === 0 && !extractError && fileName && (
        <p className="muted">Aucune ligne exploitable détectée dans ce fichier.</p>
      )}
    </div>
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
