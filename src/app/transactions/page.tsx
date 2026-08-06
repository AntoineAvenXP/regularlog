"use client";

import { useEffect, useMemo, useState } from "react";
import { writeBatch, doc, collection } from "firebase/firestore";
import Shell from "@/components/Shell";
import { db } from "@/lib/firebase";
import { COL, createOwned, listOwned, updateOwned } from "@/lib/db";
import type {
  AccountingRule,
  BankAccount,
  Entity,
  JustificatifStatus,
  Transaction,
} from "@/lib/types";
import { fmtAmount } from "@/lib/parsing";
import { suggestCode, defaultMotifFromLibelle } from "@/lib/rules";
import { useAuth } from "@/lib/auth";

const JUSTIF_STATUS: JustificatifStatus[] = [
  "manquant",
  "rattache",
  "perdu",
  "sans_objet",
];

export default function TransactionsPage() {
  return (
    <Shell>
      <TxTable />
    </Shell>
  );
}

function TxTable() {
  const { user } = useAuth();
  const [entities, setEntities] = useState<Entity[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [tx, setTx] = useState<Transaction[]>([]);
  const [rules, setRules] = useState<AccountingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  // Filtres
  const [fEntity, setFEntity] = useState("");
  const [fAccount, setFAccount] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fOrigine, setFOrigine] = useState("");
  const [fFlux, setFFlux] = useState("");
  const [fMonth, setFMonth] = useState("");
  const [search, setSearch] = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCode, setBulkCode] = useState("");

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [e, a, t, r] = await Promise.all([
        listOwned<Entity>(COL.entities),
        listOwned<BankAccount>(COL.accounts),
        listOwned<Transaction>(COL.transactions),
        listOwned<AccountingRule>(COL.rules),
      ]);
      setEntities(e);
      setAccounts(a);
      setTx(t.sort((x, y) => (x.dateOperation < y.dateOperation ? 1 : -1)));
      setRules(r);
      setLoading(false);
    })();
  }, [user]);

  const entName = (id: string) => entities.find((e) => e.id === id)?.denomination ?? "—";
  const accName = (id: string) => accounts.find((a) => a.id === id)?.libelle ?? "—";

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return tx.filter((t) => {
      if (fEntity && t.entityId !== fEntity) return false;
      if (fAccount && t.bankAccountId !== fAccount) return false;
      if (fStatus && t.justificatifStatus !== fStatus) return false;
      if (fOrigine && t.origine !== fOrigine) return false;
      if (fFlux === "oui" && !t.fluxInterne) return false;
      if (fFlux === "non" && t.fluxInterne) return false;
      if (fMonth && !(t.dateOperation || "").startsWith(fMonth)) return false;
      if (s && !(t.libelleBrut || "").toLowerCase().includes(s)) return false;
      return true;
    });
  }, [tx, fEntity, fAccount, fStatus, fOrigine, fFlux, fMonth, search]);

  async function patch(id: string, data: Partial<Transaction>) {
    setTx((prev) => prev.map((t) => (t.id === id ? { ...t, ...data } : t)));
    await updateOwned(COL.transactions, id, data as Record<string, unknown>);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((t) => t.id)));
  }

  async function applyBulkCode() {
    if (!bulkCode.trim() || selected.size === 0) return;
    const ids = [...selected];
    setTx((prev) =>
      prev.map((t) => (selected.has(t.id) ? { ...t, codeValide: bulkCode.trim() } : t))
    );
    for (const id of ids) await updateOwned(COL.transactions, id, { codeValide: bulkCode.trim() });
    setBulkCode("");
  }
  async function markLost() {
    if (selected.size === 0) return;
    const ids = [...selected];
    setTx((prev) =>
      prev.map((t) => (selected.has(t.id) ? { ...t, justificatifStatus: "perdu" } : t))
    );
    for (const id of ids)
      await updateOwned(COL.transactions, id, { justificatifStatus: "perdu" });
    setSelected(new Set());
  }

  // Applique le moteur de règles → remplit codeSuggere (jamais codeValide).
  async function applyRules() {
    if (rules.length === 0) {
      alert("Aucune règle définie. Ajoute des règles dans l'onglet Règles.");
      return;
    }
    setApplying(true);
    try {
      const changes: { id: string; code: string }[] = [];
      for (const t of tx) {
        const s = suggestCode(t.libelleBrut, rules);
        const code = s?.code ?? null;
        if (code && code !== (t.codeSuggere ?? null)) changes.push({ id: t.id, code });
      }
      for (let i = 0; i < changes.length; i += 400) {
        const chunk = changes.slice(i, i + 400);
        const batch = writeBatch(db);
        for (const c of chunk)
          batch.update(doc(db, COL.transactions, c.id), { codeSuggere: c.code });
        await batch.commit();
      }
      setTx((prev) =>
        prev.map((t) => {
          const c = changes.find((x) => x.id === t.id);
          return c ? { ...t, codeSuggere: c.code } : t;
        })
      );
      alert(`${changes.length} suggestion(s) mise(s) à jour.`);
    } finally {
      setApplying(false);
    }
  }

  // À chaque validation manuelle d'un code, propose d'enregistrer une règle (§6).
  async function proposeRule(t: Transaction, code: string) {
    const already = suggestCode(t.libelleBrut, rules);
    if (already && already.code === code) return; // déjà couvert
    const suggestion = defaultMotifFromLibelle(t.libelleBrut);
    const motif = window.prompt(
      `Créer une règle : tout libellé contenant ce motif recevra le code ${code}.\n\nMotif (laisser vide pour ne pas créer) :`,
      suggestion
    );
    if (motif && motif.trim()) {
      const id = await createOwned(COL.rules, {
        motif: motif.trim(),
        code,
        priorite: 0,
        libelleCode: null,
      });
      setRules((prev) => [
        ...prev,
        { id, ownerUid: "", motif: motif.trim(), code, priorite: 0 } as AccountingRule,
      ]);
    }
  }

  function exportCsv() {
    const cols = [
      "date_operation",
      "date_valeur",
      "entite",
      "compte",
      "libelle",
      "montant",
      "code_valide",
      "code_suggere",
      "categorie",
      "statut_justificatif",
      "flux_interne",
      "origine",
      "a_verifier",
      "notes",
    ];
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(";")];
    for (const t of filtered) {
      lines.push(
        [
          t.dateOperation,
          t.dateValeur ?? "",
          entName(t.entityId),
          accName(t.bankAccountId),
          t.libelleBrut,
          String(t.montant).replace(".", ","),
          t.codeValide ?? "",
          t.codeSuggere ?? "",
          t.categorie ?? "",
          t.justificatifStatus,
          t.fluxInterne ? "oui" : "non",
          t.origine,
          t.aVerifier ? "oui" : "non",
          t.notes ?? "",
        ]
          .map(esc)
          .join(";")
      );
    }
    const blob = new Blob(["﻿" + lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `regularlog-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <p className="muted">Chargement…</p>;

  const total = filtered.reduce((s, t) => s + t.montant, 0);

  return (
    <div>
      <h1 className="page">Transactions</h1>
      <p className="sub">
        {filtered.length} ligne(s) · solde filtré {fmtAmount(total)}
      </p>

      <div className="toolbar">
        <select value={fEntity} onChange={(e) => setFEntity(e.target.value)}>
          <option value="">Toutes entités</option>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>{e.denomination}</option>
          ))}
        </select>
        <select value={fAccount} onChange={(e) => setFAccount(e.target.value)}>
          <option value="">Tous comptes</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.libelle}</option>
          ))}
        </select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="">Tout justificatif</option>
          {JUSTIF_STATUS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select value={fOrigine} onChange={(e) => setFOrigine(e.target.value)}>
          <option value="">Toute origine</option>
          <option value="import_csv">import_csv</option>
          <option value="import_excel">import_excel</option>
          <option value="import_pdf">import_pdf</option>
          <option value="import_ocr">import_ocr</option>
          <option value="bridge">bridge</option>
          <option value="saisie_manuelle">saisie_manuelle</option>
        </select>
        <select value={fFlux} onChange={(e) => setFFlux(e.target.value)}>
          <option value="">Flux interne : tous</option>
          <option value="oui">Flux interne</option>
          <option value="non">Hors flux interne</option>
        </select>
        <input
          type="month"
          value={fMonth}
          onChange={(e) => setFMonth(e.target.value)}
          style={{ padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 8 }}
        />
        <input
          placeholder="Recherche libellé…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 8, minWidth: 200 }}
        />
        <button
          className="btn secondary"
          onClick={applyRules}
          disabled={applying}
          style={{ marginLeft: "auto" }}
          title="Remplit les codes suggérés à partir du référentiel de règles"
        >
          {applying ? "Application…" : "Appliquer les règles"}
        </button>
        <button className="btn secondary" onClick={exportCsv}>
          Exporter CSV
        </button>
      </div>

      {selected.size > 0 && (
        <div className="toolbar" style={{ background: "#eff6ff", padding: 10, borderRadius: 8 }}>
          <strong>{selected.size} sélectionnée(s)</strong>
          <input
            placeholder="Code à appliquer"
            value={bulkCode}
            onChange={(e) => setBulkCode(e.target.value)}
            style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 8 }}
          />
          <button className="btn" onClick={applyBulkCode}>Appliquer le code</button>
          <button className="btn danger" onClick={markLost}>Marquer « perdu »</button>
          <button className="btn secondary" onClick={() => setSelected(new Set())}>Désélectionner</button>
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table className="grid">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={selected.size > 0 && selected.size === filtered.length}
                  onChange={toggleAll}
                />
              </th>
              <th>Date</th>
              <th>Compte</th>
              <th>Libellé</th>
              <th>Montant</th>
              <th>Code</th>
              <th>Catégorie</th>
              <th>Justificatif</th>
              <th>Origine</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 1000).map((t) => (
              <tr key={t.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    onChange={() => toggle(t.id)}
                  />
                </td>
                <td>{t.dateOperation}</td>
                <td>{accName(t.bankAccountId)}</td>
                <td style={{ whiteSpace: "normal", maxWidth: 320 }}>
                  {t.libelleBrut}
                  {t.aVerifier && <span className="badge verif" style={{ marginLeft: 6 }}>à vérifier</span>}
                  {t.fluxInterne && <span className="badge sans_objet" style={{ marginLeft: 6 }}>flux interne</span>}
                </td>
                <td style={{ color: t.montant < 0 ? "var(--red)" : "var(--green)" }}>
                  {fmtAmount(t.montant)}
                </td>
                <td>
                  <input
                    defaultValue={t.codeValide ?? ""}
                    placeholder={t.codeSuggere ? `suggéré : ${t.codeSuggere}` : ""}
                    onBlur={async (e) => {
                      const v = e.target.value.trim() || null;
                      if (v === (t.codeValide ?? null)) return;
                      await patch(t.id, { codeValide: v });
                      if (v) proposeRule(t, v);
                    }}
                  />
                </td>
                <td>
                  <input
                    defaultValue={t.categorie ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim() || null;
                      if (v !== (t.categorie ?? null)) patch(t.id, { categorie: v });
                    }}
                  />
                </td>
                <td>
                  <select
                    value={t.justificatifStatus}
                    onChange={(e) =>
                      patch(t.id, { justificatifStatus: e.target.value as JustificatifStatus })
                    }
                  >
                    {JUSTIF_STATUS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td className="muted" style={{ fontSize: 11 }}>{t.origine}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > 1000 && (
          <p className="muted">Affichage limité à 1000 lignes ; l&apos;export CSV contient tout le filtre.</p>
        )}
      </div>
    </div>
  );
}
