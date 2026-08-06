"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { COL, createOwned, deleteOwned, listOwned, updateOwned } from "@/lib/db";
import type { AccountingCode, AccountingRule } from "@/lib/types";
import { useAuth } from "@/lib/auth";

export default function ReglesPage() {
  return (
    <Shell>
      <Regles />
    </Shell>
  );
}

function Regles() {
  const { user } = useAuth();
  const [rules, setRules] = useState<AccountingRule[]>([]);
  const [codes, setCodes] = useState<AccountingCode[]>([]);
  const [loading, setLoading] = useState(true);

  const [motif, setMotif] = useState("");
  const [code, setCode] = useState("");
  const [priorite, setPriorite] = useState("0");

  async function reload() {
    const [r, c] = await Promise.all([
      listOwned<AccountingRule>(COL.rules),
      listOwned<AccountingCode>(COL.codes),
    ]);
    setRules(r.sort((a, b) => (b.priorite ?? 0) - (a.priorite ?? 0)));
    setCodes(c.sort((a, b) => a.code.localeCompare(b.code)));
    setLoading(false);
  }
  useEffect(() => {
    if (user) reload();
  }, [user]);

  async function add(ev: React.FormEvent) {
    ev.preventDefault();
    if (!motif.trim() || !code.trim()) return;
    await createOwned(COL.rules, {
      motif: motif.trim(),
      code: code.trim(),
      priorite: Number(priorite) || 0,
      libelleCode: codes.find((c) => c.code === code.trim())?.libelle ?? null,
    });
    setMotif("");
    setCode("");
    setPriorite("0");
    reload();
  }

  if (loading) return <p className="muted">Chargement…</p>;

  return (
    <div>
      <h1 className="page">Règles</h1>
      <p className="sub">
        Référentiel libellé → code comptable. S&apos;enrichit à chaque validation
        dans Transactions.
      </p>

      <form onSubmit={add} className="card" style={{ marginBottom: 16 }}>
        <div className="row">
          <div className="field" style={{ flex: 2 }}>
            <label>Motif (contenu dans le libellé)</label>
            <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="ex. urssaf, edf, loyer…" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Code comptable</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ex. 645"
              list="codes-list"
            />
            <datalist id="codes-list">
              {codes.map((c) => (
                <option key={c.id} value={c.code}>{c.code} — {c.libelle}</option>
              ))}
            </datalist>
          </div>
          <div className="field" style={{ width: 90 }}>
            <label>Priorité</label>
            <input type="number" value={priorite} onChange={(e) => setPriorite(e.target.value)} />
          </div>
          <button className="btn" style={{ alignSelf: "flex-end" }}>Ajouter</button>
        </div>
      </form>

      <table className="grid">
        <thead>
          <tr>
            <th>Motif</th>
            <th>Code</th>
            <th>Priorité</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td>
                <input
                  defaultValue={r.motif}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== r.motif) updateOwned(COL.rules, r.id, { motif: v }).then(reload);
                  }}
                  style={{ maxWidth: 260 }}
                />
              </td>
              <td>
                <input
                  defaultValue={r.code}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== r.code) updateOwned(COL.rules, r.id, { code: v }).then(reload);
                  }}
                  style={{ maxWidth: 90 }}
                />
              </td>
              <td>
                <input
                  type="number"
                  defaultValue={r.priorite ?? 0}
                  onBlur={(e) => {
                    const v = Number(e.target.value) || 0;
                    if (v !== (r.priorite ?? 0)) updateOwned(COL.rules, r.id, { priorite: v }).then(reload);
                  }}
                  style={{ maxWidth: 70 }}
                />
              </td>
              <td>
                <button className="btn secondary" onClick={() => deleteOwned(COL.rules, r.id).then(reload)}>
                  Supprimer
                </button>
              </td>
            </tr>
          ))}
          {rules.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">Aucune règle. Ajoute-en une, ou valide un code dans Transactions (proposition automatique).</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
