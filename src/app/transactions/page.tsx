"use client";

import { useEffect, useMemo, useState } from "react";
import { writeBatch, doc } from "firebase/firestore";
import { Briefcase, User, ArrowLeftRight } from "lucide-react";
import Shell from "@/components/Shell";
import { db } from "@/lib/firebase";
import { COL, createOwned, listOwned, updateOwned } from "@/lib/db";
import type {
  Affectation,
  AccountingRule,
  BankAccount,
  Category,
  Entity,
  JustificatifStatus,
  Transaction,
  Usage,
} from "@/lib/types";
import { fmtAmount } from "@/lib/parsing";
import { suggestCode, defaultMotifFromLibelle } from "@/lib/rules";
import {
  AFFECTATIONS,
  AFFECTATION_LABEL,
  accountUsageMap,
  entityTypeMap,
  matchesUsage,
  usageOf,
} from "@/lib/usage";
import { useUsageFilter } from "@/lib/usageFilter";
import { useAuth } from "@/lib/auth";

/** Tri des comptes par numéro (IBAN partiel) puis libellé. */
function byAccountNumber(a: BankAccount, b: BankAccount): number {
  const na = a.ibanPartiel ?? "";
  const nb = b.ibanPartiel ?? "";
  if (na !== nb) return na < nb ? -1 : 1;
  return a.libelle.localeCompare(b.libelle);
}

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
  const { mode } = useUsageFilter();
  const [entities, setEntities] = useState<Entity[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [tx, setTx] = useState<Transaction[]>([]);
  const [rules, setRules] = useState<AccountingRule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  // Filtres
  const [fEntity, setFEntity] = useState("");
  const [fAccount, setFAccount] = useState("");
  // Vrai quand l'utilisateur a explicitement choisi « Tous les comptes » ("").
  const [allAccountsChosen, setAllAccountsChosen] = useState(false);
  const [fStatus, setFStatus] = useState("");
  const [fOrigine, setFOrigine] = useState("");
  const [fFlux, setFFlux] = useState("");
  const [fCategorie, setFCategorie] = useState("");
  const [fMonth, setFMonth] = useState("");
  const [search, setSearch] = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCode, setBulkCode] = useState("");

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [e, a, t, r, cat] = await Promise.all([
        listOwned<Entity>(COL.entities),
        listOwned<BankAccount>(COL.accounts),
        listOwned<Transaction>(COL.transactions),
        listOwned<AccountingRule>(COL.rules),
        listOwned<Category>(COL.categories),
      ]);
      setEntities(e);
      setAccounts(a);
      setTx(t.sort((x, y) => (x.dateOperation < y.dateOperation ? 1 : -1)));
      setRules(r);
      setCategories(
        cat.sort((x, y) => (x.ordre ?? 0) - (y.ordre ?? 0) || x.nom.localeCompare(y.nom))
      );
      setLoading(false);
    })();
  }, [user]);

  const entName = (id: string) => entities.find((e) => e.id === id)?.denomination ?? "—";
  const accName = (id: string) => accounts.find((a) => a.id === id)?.libelle ?? "—";
  const typeById = useMemo(() => entityTypeMap(entities), [entities]);
  const txById = useMemo(() => new Map(tx.map((t) => [t.id, t])), [tx]);
  // Compte « en face » d'un flux interne (pour le survol).
  const mirrorAccountName = (t: Transaction) => {
    const m = t.transactionMiroirId ? txById.get(t.transactionMiroirId) : null;
    return m ? accName(m.bankAccountId) : "un autre compte";
  };
  const accUsageById = useMemo(() => accountUsageMap(accounts), [accounts]);
  const sortedAccounts = useMemo(() => [...accounts].sort(byAccountNumber), [accounts]);
  const selectedAccount = accounts.find((a) => a.id === fAccount) || null;

  // Par défaut : le PREMIER compte (par numéro). « Tous les comptes » = valeur "".
  useEffect(() => {
    if (!loading && fAccount === "" && !allAccountsChosen && sortedAccounts.length > 0) {
      setFAccount(sortedAccounts[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, sortedAccounts]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return tx.filter((t) => {
      if (!matchesUsage(t, mode, accUsageById, typeById)) return false;
      if (fEntity && t.entityId !== fEntity) return false;
      if (fAccount && t.bankAccountId !== fAccount) return false;
      if (fStatus && t.justificatifStatus !== fStatus) return false;
      if (fOrigine && t.origine !== fOrigine) return false;
      if (fFlux === "oui" && !t.fluxInterne) return false;
      if (fFlux === "non" && t.fluxInterne) return false;
      if (fCategorie === "__none__" && (t.categorie ?? "") !== "") return false;
      if (fCategorie && fCategorie !== "__none__" && t.categorie !== fCategorie) return false;
      if (fMonth && !(t.dateOperation || "").startsWith(fMonth)) return false;
      if (s && !(t.libelleBrut || "").toLowerCase().includes(s)) return false;
      return true;
    });
  }, [tx, mode, accUsageById, typeById, fEntity, fAccount, fStatus, fOrigine, fFlux, fCategorie, fMonth, search]);

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

  // Bascule Pro/Perso du COMPTE sélectionné (le type du compte, pas la ligne).
  async function toggleAccountUsage(acc: BankAccount) {
    const next: Usage = (acc.usage ?? "perso") === "pro" ? "perso" : "pro";
    setAccounts((prev) => prev.map((a) => (a.id === acc.id ? { ...a, usage: next } : a)));
    await updateOwned(COL.accounts, acc.id, { usage: next });
  }
  // Affectation d'une opération (finalité IA, corrigeable).
  async function setAffectation(t: Transaction, aff: Affectation | null) {
    await patch(t.id, { affectation: aff });
  }
  async function applyBulkAffectation(aff: Affectation | null) {
    if (selected.size === 0) return;
    const ids = [...selected];
    setTx((prev) => prev.map((t) => (selected.has(t.id) ? { ...t, affectation: aff } : t)));
    for (const id of ids) await updateOwned(COL.transactions, id, { affectation: aff });
  }
  async function applyBulkCategory(cat: string) {
    if (selected.size === 0) return;
    const value = cat || null;
    const ids = [...selected];
    setTx((prev) => prev.map((t) => (selected.has(t.id) ? { ...t, categorie: value } : t)));
    for (const id of ids) await updateOwned(COL.transactions, id, { categorie: value });
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
      "type_compte",
      "affectation",
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
          usageOf(t, accUsageById, typeById),
          t.affectation ? AFFECTATION_LABEL[t.affectation] : "",
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
        <select
          value={fAccount}
          onChange={(e) => {
            setFAccount(e.target.value);
            setAllAccountsChosen(e.target.value === "");
          }}
        >
          <option value="">Tous les comptes</option>
          {sortedAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.libelle}{a.ibanPartiel ? ` · …${a.ibanPartiel}` : ""}
            </option>
          ))}
        </select>
        {selectedAccount && (
          <button
            className="usage-pill"
            data-usage={selectedAccount.usage ?? "perso"}
            onClick={() => toggleAccountUsage(selectedAccount)}
            title="Type du compte — cliquer pour basculer Pro / Perso"
          >
            {(selectedAccount.usage ?? "perso") === "pro" ? <Briefcase size={12} /> : <User size={12} />}
            Compte {(selectedAccount.usage ?? "perso") === "pro" ? "Pro" : "Perso"}
          </button>
        )}
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
        <select value={fCategorie} onChange={(e) => setFCategorie(e.target.value)}>
          <option value="">Toute catégorie</option>
          <option value="__none__">Sans catégorie</option>
          {categories.map((c) => (
            <option key={c.id} value={c.nom}>{c.nom}</option>
          ))}
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
        <div className="toolbar" style={{ background: "#eaf3e4", padding: 10, borderRadius: 8 }}>
          <strong>{selected.size} sélectionnée(s)</strong>
          <input
            placeholder="Code à appliquer"
            value={bulkCode}
            onChange={(e) => setBulkCode(e.target.value)}
            style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 8 }}
          />
          <button className="btn" onClick={applyBulkCode}>Appliquer le code</button>
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) applyBulkCategory(e.target.value === "__clear__" ? "" : e.target.value);
              e.target.value = "";
            }}
            style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 8 }}
          >
            <option value="">Catégorie…</option>
            <option value="__clear__">— aucune —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.nom}>{c.nom}</option>
            ))}
          </select>
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value)
                applyBulkAffectation(e.target.value === "__clear__" ? null : (e.target.value as Affectation));
              e.target.value = "";
            }}
            style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 8 }}
          >
            <option value="">Affectation…</option>
            <option value="__clear__">— aucune —</option>
            {AFFECTATIONS.map((a) => (
              <option key={a} value={a}>{AFFECTATION_LABEL[a]}</option>
            ))}
          </select>
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
              <th>Affectation</th>
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
                  {t.fluxInterne && (
                    <span
                      className="flux-badge"
                      title={`Flux interne ↔ ${mirrorAccountName(t)}`}
                      style={{ marginLeft: 6 }}
                    >
                      <ArrowLeftRight size={11} /> flux interne
                    </span>
                  )}
                </td>
                <td style={{ color: t.montant < 0 ? "var(--red)" : "var(--green)" }}>
                  {fmtAmount(t.montant)}
                </td>
                <td>
                  <select
                    className="affectation-select"
                    data-aff={t.affectation ?? ""}
                    value={t.affectation ?? ""}
                    onChange={(e) => setAffectation(t, (e.target.value || null) as Affectation | null)}
                  >
                    <option value="">—</option>
                    {AFFECTATIONS.map((a) => (
                      <option key={a} value={a}>{AFFECTATION_LABEL[a]}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    defaultValue={t.codeValide ?? t.codeSuggere ?? ""}
                    placeholder={t.codeSuggere ? `suggéré : ${t.codeSuggere}` : "code"}
                    title="Code comptable — suggéré par l'IA, modifiable. Transmis au cabinet à titre de suggestion."
                    onBlur={async (e) => {
                      const v = e.target.value.trim() || null;
                      if (v === (t.codeValide ?? null)) return;
                      await patch(t.id, { codeValide: v });
                      if (v) proposeRule(t, v);
                    }}
                  />
                </td>
                <td>
                  <select
                    value={t.categorie ?? ""}
                    onChange={(e) => {
                      const v = e.target.value || null;
                      if (v !== (t.categorie ?? null)) patch(t.id, { categorie: v });
                    }}
                  >
                    <option value="">—</option>
                    {t.categorie && !categories.some((c) => c.nom === t.categorie) && (
                      <option value={t.categorie}>{t.categorie}</option>
                    )}
                    {categories.map((c) => (
                      <option key={c.id} value={c.nom}>{c.nom}</option>
                    ))}
                  </select>
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
