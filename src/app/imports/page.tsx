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
import { useAuth } from "@/lib/auth";

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
  const [kind, setKind] = useState<"csv" | "excel">("csv");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);

  // Mappage
  const [colDate, setColDate] = useState("");
  const [colDateValeur, setColDateValeur] = useState("");
  const [colLibelle, setColLibelle] = useState("");
  const [amountMode, setAmountMode] = useState<AmountMode>("single");
  const [colMontant, setColMontant] = useState("");
  const [colDebit, setColDebit] = useState("");
  const [colCredit, setColCredit] = useState("");
  const [decimal, setDecimal] = useState<"," | ".">(",");

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

  // Charge le mappage mémorisé pour la banque du compte choisi.
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

  async function onFile(f: File) {
    setDone(null);
    setFileName(f.name);
    const isExcel = /\.xlsx?$/i.test(f.name);
    setKind(isExcel ? "excel" : "csv");
    if (isExcel) {
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const arr = XLSX.utils.sheet_to_json<string[]>(sheet, {
        header: 1,
        raw: false,
        defval: "",
      });
      applyRows(arr.map((r) => r.map((c) => String(c ?? ""))));
    } else {
      const text = await f.text();
      const parsed = Papa.parse<string[]>(text, {
        skipEmptyLines: true,
      });
      applyRows((parsed.data as string[][]).map((r) => r.map((c) => String(c ?? ""))));
    }
  }

  function applyRows(all: string[][]) {
    if (all.length === 0) {
      setHeaders([]);
      setRows([]);
      return;
    }
    setHeaders(all[0]);
    setRows(all.slice(1));
  }

  // Recharge les empreintes existantes du compte pour la dédup.
  useEffect(() => {
    if (!accountId) return;
    (async () => {
      const tx = await listOwned<Transaction>(COL.transactions);
      const fps = new Set(
        tx
          .filter((t) => t.bankAccountId === accountId)
          .map((t) => t.fingerprint)
      );
      setExistingFps(fps);
    })().catch(() => setExistingFps(new Set()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, done]);

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
      if (amountMode === "single") {
        montant = iMont >= 0 ? parseAmount(r[iMont], decimal) : null;
      } else {
        const deb = iDeb >= 0 ? parseAmount(r[iDeb], decimal) : null;
        const cred = iCred >= 0 ? parseAmount(r[iCred], decimal) : null;
        if (deb != null || cred != null) {
          montant = (cred ?? 0) - Math.abs(deb ?? 0);
        }
      }
      let valid = true;
      let reason = "";
      if (!dateOperation) {
        valid = false;
        reason = "date illisible";
      } else if (montant == null) {
        valid = false;
        reason = "montant illisible";
      } else if (!libelle) {
        valid = false;
        reason = "libellé vide";
      }
      const fp = valid
        ? fingerprint(account.id, dateOperation as string, montant as number, libelle)
        : "";
      const dupExisting = valid && existingFps.has(fp);
      const dupBatch = valid && seen.has(fp);
      if (valid) seen.add(fp);
      return {
        dateOperation,
        dateValeur,
        libelle,
        montant,
        valid,
        reason,
        fp,
        dupExisting,
        dupBatch,
        include: valid && !dupExisting && !dupBatch,
      };
    });
  }, [
    account,
    headers,
    rows,
    colDate,
    colDateValeur,
    colLibelle,
    amountMode,
    colMontant,
    colDebit,
    colCredit,
    decimal,
    existingFps,
  ]);

  const stats = useMemo(() => {
    const valid = preview.filter((p) => p.valid).length;
    const dup = preview.filter((p) => p.dupExisting || p.dupBatch).length;
    const invalid = preview.length - valid;
    const toImport = preview.filter((p) => p.include && p.valid).length;
    return { valid, dup, invalid, toImport };
  }, [preview]);

  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const included = (i: number) =>
    overrides[i] !== undefined ? overrides[i] : preview[i]?.include;

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
      const rowsToImport = preview
        .map((p, i) => ({ p, i }))
        .filter(({ p, i }) => p.valid && included(i));

      const importId = await createOwned(COL.imports, {
        kind,
        banque: account.banque,
        bankAccountId: account.id,
        sourceStoragePath: null, // conservation du fichier source : Tranche Storage
        nomFichier: fileName,
        nbLignes: rowsToImport.length,
      });

      const uid = currentUid();
      const origine = kind === "excel" ? "import_excel" : "import_csv";
      for (let i = 0; i < rowsToImport.length; i += 400) {
        const chunk = rowsToImport.slice(i, i + 400);
        const batch = writeBatch(db);
        for (const { p } of chunk) {
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
            aVerifier: false,
            notes: null,
            importId,
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
      }
      setDone(`${rowsToImport.length} transaction(s) importée(s).`);
      setHeaders([]);
      setRows([]);
      setFileName("");
      setOverrides({});
    } finally {
      setBusy(false);
    }
  }

  const accLabel = (a: BankAccount) => {
    const en = entities.find((e) => e.id === a.entityId)?.denomination ?? "—";
    return `${a.libelle} · ${a.banque} · ${en}`;
  };

  return (
    <div>
      <h1 className="page">Imports</h1>
      <p className="sub">CSV / Excel — rien n&apos;est enregistré avant validation</p>

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
            <label>Fichier (CSV, XLS, XLSX)</label>
            <input
              type="file"
              accept=".csv,.xls,.xlsx"
              disabled={!accountId}
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
          </div>
        </div>
        {accounts.length === 0 && (
          <p className="muted" style={{ marginTop: 8 }}>
            Crée d&apos;abord un compte dans <strong>Paramètres</strong>.
          </p>
        )}
      </div>

      {headers.length > 0 && account && (
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
            <span><strong>{stats.valid}</strong> valides</span>
            <span style={{ color: "var(--amber)" }}><strong>{stats.dup}</strong> doublons présumés</span>
            <span style={{ color: "var(--red)" }}><strong>{stats.invalid}</strong> illisibles</span>
            <span style={{ marginLeft: "auto" }}>À importer : <strong>{preview.filter((_, i) => included(i) && preview[i].valid).length}</strong></span>
            <button className="btn" disabled={busy || stats.toImport === 0} onClick={runImport}>
              {busy ? "Import…" : "Valider l'import"}
            </button>
          </div>

          <div style={{ overflowX: "auto", maxHeight: 460, overflowY: "auto" }}>
            <table className="grid">
              <thead>
                <tr>
                  <th>Import ?</th>
                  <th>Date</th>
                  <th>Libellé</th>
                  <th>Montant</th>
                  <th>État</th>
                </tr>
              </thead>
              <tbody>
                {preview.slice(0, 500).map((p, i) => (
                  <tr key={i} style={{ opacity: p.valid ? 1 : 0.5 }}>
                    <td>
                      <input
                        type="checkbox"
                        disabled={!p.valid}
                        checked={!!included(i)}
                        onChange={(e) => setOverrides((o) => ({ ...o, [i]: e.target.checked }))}
                      />
                    </td>
                    <td>{p.dateOperation ?? "—"}</td>
                    <td style={{ whiteSpace: "normal", maxWidth: 380 }}>{p.libelle || "—"}</td>
                    <td style={{ color: (p.montant ?? 0) < 0 ? "var(--red)" : "var(--green)" }}>
                      {p.montant != null ? fmtAmount(p.montant) : "—"}
                    </td>
                    <td>
                      {!p.valid ? (
                        <span className="badge manquant">{p.reason}</span>
                      ) : p.dupExisting ? (
                        <span className="badge verif">doublon (déjà en base)</span>
                      ) : p.dupBatch ? (
                        <span className="badge verif">doublon (dans le fichier)</span>
                      ) : (
                        <span className="badge rattache">ok</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.length > 500 && (
              <p className="muted">Aperçu limité à 500 lignes ; l&apos;import traite tout.</p>
            )}
          </div>
        </>
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
          <option key={`${h}-${i}`} value={h}>
            {h || `(colonne ${i + 1})`}
          </option>
        ))}
      </select>
    </div>
  );
}
