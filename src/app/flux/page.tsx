"use client";

import { useEffect, useMemo, useState } from "react";
import { writeBatch, doc } from "firebase/firestore";
import Shell from "@/components/Shell";
import { db } from "@/lib/firebase";
import { COL, listOwned } from "@/lib/db";
import type { BankAccount, Entity, Transaction } from "@/lib/types";
import { fmtAmount } from "@/lib/parsing";
import { useAuth } from "@/lib/auth";

export default function FluxPage() {
  return (
    <Shell>
      <Flux />
    </Shell>
  );
}

function Flux() {
  const { user } = useAuth();
  const [tx, setTx] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  async function reload() {
    const [t, a, e] = await Promise.all([
      listOwned<Transaction>(COL.transactions),
      listOwned<BankAccount>(COL.accounts),
      listOwned<Entity>(COL.entities),
    ]);
    setTx(t);
    setAccounts(a);
    setEntities(e);
    setLoading(false);
  }
  useEffect(() => {
    if (user) reload();
  }, [user]);

  const accName = (id: string) => accounts.find((a) => a.id === id)?.libelle ?? "—";
  const accEntity = (id: string) => accounts.find((a) => a.id === id)?.entityId ?? "";
  const entName = (id: string) => entities.find((e) => e.id === id)?.denomination ?? "—";

  async function unlink(a: Transaction) {
    setBusy(true);
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, COL.transactions, a.id), {
        fluxInterne: false,
        transactionMiroirId: null,
      });
      if (a.transactionMiroirId)
        batch.update(doc(db, COL.transactions, a.transactionMiroirId), {
          fluxInterne: false,
          transactionMiroirId: null,
        });
      await batch.commit();
      await reload();
    } finally {
      setBusy(false);
    }
  }

  // Paires liées existantes (une par crédit).
  const linked = useMemo(() => {
    const byId = new Map(tx.map((t) => [t.id, t]));
    const pairs: { pos: Transaction; neg: Transaction | null }[] = [];
    for (const t of tx) {
      if (!t.fluxInterne) continue;
      if (t.montant > 0) {
        pairs.push({
          pos: t,
          neg: t.transactionMiroirId ? byId.get(t.transactionMiroirId) ?? null : null,
        });
      }
    }
    return pairs.sort((a, b) => (a.pos.dateOperation < b.pos.dateOperation ? 1 : -1));
  }, [tx]);

  // Cumuls par sens + par entité.
  const totals = useMemo(() => {
    let entrant = 0;
    let sortant = 0;
    const byEntity = new Map<string, { entrant: number; sortant: number }>();
    const bump = (eid: string, k: "entrant" | "sortant", v: number) => {
      const cur = byEntity.get(eid) ?? { entrant: 0, sortant: 0 };
      cur[k] += v;
      byEntity.set(eid, cur);
    };
    for (const t of tx) {
      if (!t.fluxInterne) continue;
      const eid = accEntity(t.bankAccountId);
      if (t.montant > 0) {
        entrant += t.montant;
        bump(eid, "entrant", t.montant);
      } else {
        sortant += Math.abs(t.montant);
        bump(eid, "sortant", Math.abs(t.montant));
      }
    }
    return { entrant, sortant, byEntity };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx, accounts]);

  if (loading) return <p className="muted">Chargement…</p>;

  return (
    <div>
      <h1 className="page">Flux internes</h1>
      <p className="sub">
        Virements entre tes comptes — ni charges ni produits. Détectés
        <strong> automatiquement</strong> à chaque import de relevé (une opération
        d&apos;un compte qui réapparaît, à l&apos;inverse, sur un autre).
      </p>

      {/* Cumuls */}
      <div className="row" style={{ gap: 16, marginBottom: 20 }}>
        <div className="card" style={{ minWidth: 160 }}>
          <div className="muted" style={{ fontSize: 12.5 }}>Total entrant</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--green)" }}>{fmtAmount(totals.entrant)}</div>
        </div>
        <div className="card" style={{ minWidth: 160 }}>
          <div className="muted" style={{ fontSize: 12.5 }}>Total sortant</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--red)" }}>{fmtAmount(totals.sortant)}</div>
        </div>
      </div>

      {totals.byEntity.size > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 15 }}>Par entité</h2>
          <table className="grid" style={{ maxWidth: 560 }}>
            <thead>
              <tr>
                <th>Entité</th>
                <th>Entrant</th>
                <th>Sortant</th>
                <th>Net</th>
              </tr>
            </thead>
            <tbody>
              {[...totals.byEntity.entries()].map(([eid, v]) => (
                <tr key={eid}>
                  <td>{entName(eid)}</td>
                  <td style={{ color: "var(--green)" }}>{fmtAmount(v.entrant)}</td>
                  <td style={{ color: "var(--red)" }}>{fmtAmount(v.sortant)}</td>
                  <td style={{ fontWeight: 700 }}>{fmtAmount(v.entrant - v.sortant)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Flux liés */}
      <h2 style={{ fontSize: 15 }}>Flux internes liés ({linked.length})</h2>
      <table className="grid">
        <thead>
          <tr>
            <th>Date</th>
            <th>Depuis</th>
            <th>Vers</th>
            <th>Montant</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {linked.map(({ pos, neg }) => (
            <tr key={pos.id}>
              <td>{(neg ?? pos).dateOperation}</td>
              <td>{neg ? `${accName(neg.bankAccountId)} (${entName(accEntity(neg.bankAccountId))})` : "—"}</td>
              <td>{accName(pos.bankAccountId)} ({entName(accEntity(pos.bankAccountId))})</td>
              <td>{fmtAmount(pos.montant)}</td>
              <td>
                <button className="btn secondary" onClick={() => unlink(pos)} disabled={busy}>
                  Délier
                </button>
              </td>
            </tr>
          ))}
          {linked.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">Aucun flux interne pour l&apos;instant. Ils apparaîtront dès qu&apos;un virement d&apos;un compte se retrouvera sur un autre relevé importé.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
