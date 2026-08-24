"use client";

import { useEffect, useMemo, useState } from "react";
import Shell from "@/components/Shell";
import { COL, listOwned } from "@/lib/db";
import type { BankAccount, Entity, ReconciliationProposal, Transaction } from "@/lib/types";
import { fmtAmount } from "@/lib/parsing";
import { accountUsageMap, entityTypeMap, matchesUsage, usageOf } from "@/lib/usage";
import { useUsageFilter } from "@/lib/usageFilter";
import { useAuth } from "@/lib/auth";

export default function HomePage() {
  return (
    <Shell>
      <Dashboard />
    </Shell>
  );
}

function monthsSince(start: string): string[] {
  const out: string[] = [];
  const [sy, sm] = start.split("-").map(Number);
  const now = new Date();
  let y = sy;
  let m = sm;
  while (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth() + 1)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function Dashboard() {
  const { user } = useAuth();
  const { mode } = useUsageFilter();
  const [allTx, setAllTx] = useState<Transaction[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [recon, setRecon] = useState<ReconciliationProposal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [t, e, a, r] = await Promise.all([
        listOwned<Transaction>(COL.transactions),
        listOwned<Entity>(COL.entities),
        listOwned<BankAccount>(COL.accounts),
        listOwned<ReconciliationProposal>(COL.reconciliations),
      ]);
      setAllTx(t);
      setEntities(e);
      setAccounts(a);
      setRecon(r);
      setLoading(false);
    })();
  }, [user]);

  const typeById = useMemo(() => entityTypeMap(entities), [entities]);
  const accUsageById = useMemo(() => accountUsageMap(accounts), [accounts]);
  const tx = useMemo(
    () => allTx.filter((t) => matchesUsage(t, mode, accUsageById, typeById)),
    [allTx, mode, accUsageById, typeById]
  );

  if (loading) return <p className="muted">Chargement…</p>;

  const entName = (id: string) => entities.find((e) => e.id === id)?.denomination ?? "—";
  const sansJustif = tx.filter((t) => t.justificatifStatus === "manquant");
  const aVerifier = tx.filter((t) => t.aVerifier);
  const montantConcerne = sansJustif.reduce((s, t) => s + Math.abs(t.montant), 0);
  const proposPending = recon.filter((r) => r.statut === "en_attente").length;

  // Sans justificatif par entité
  const byEntity = new Map<string, number>();
  for (const t of sansJustif) byEntity.set(t.entityId, (byEntity.get(t.entityId) ?? 0) + 1);
  // Sans justificatif par exercice (année)
  const byYear = new Map<string, number>();
  for (const t of sansJustif) {
    const y = (t.dateOperation || "").slice(0, 4) || "—";
    byYear.set(y, (byYear.get(y) ?? 0) + 1);
  }
  // Répartition par code validé
  const byCode = new Map<string, { count: number; montant: number }>();
  for (const t of tx) {
    const c = t.codeValide || "(non affecté)";
    const cur = byCode.get(c) ?? { count: 0, montant: 0 };
    cur.count += 1;
    cur.montant += t.montant;
    byCode.set(c, cur);
  }
  // Répartition par catégorie usuelle
  const byCategorie = new Map<string, { count: number; montant: number }>();
  for (const t of tx) {
    const c = t.categorie || "(sans catégorie)";
    const cur = byCategorie.get(c) ?? { count: 0, montant: 0 };
    cur.count += 1;
    cur.montant += t.montant;
    byCategorie.set(c, cur);
  }
  // Ventilation pro / perso (seulement pertinente en vue « Tout »)
  let proCount = 0;
  let persoCount = 0;
  for (const t of tx) (usageOf(t, accUsageById, typeById) === "pro" ? (proCount++) : (persoCount++));

  const withMonth = new Set(tx.map((t) => (t.dateOperation || "").slice(0, 7)));
  const months = monthsSince("2024-01");

  return (
    <div>
      <h1 className="page">Tableau de bord</h1>
      <p className="sub">
        Reconstitution depuis janvier 2024
        {mode !== "tout" && ` · vue ${mode === "pro" ? "professionnelle" : "personnelle"}`}
      </p>

      <div className="row" style={{ gap: 16, marginBottom: 24 }}>
        <Stat label="Transactions" value={String(tx.length)} />
        {mode === "tout" && (
          <Stat label="Pro / Perso" value={`${proCount} / ${persoCount}`} />
        )}
        <Stat label="Sans justificatif" value={String(sansJustif.length)} tone="red" />
        <Stat label="Montant concerné" value={fmtAmount(montantConcerne)} tone="red" />
        <Stat label="À vérifier (OCR)" value={String(aVerifier.length)} tone="amber" />
        <Stat label="Rapprochements en attente" value={String(proposPending)} tone="amber" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.4fr", gap: 16, marginBottom: 24 }}>
        <MiniTable
          title="Sans justificatif — par entité"
          rows={[...byEntity.entries()].map(([id, n]) => [entName(id), String(n)])}
        />
        <MiniTable
          title="Sans justificatif — par exercice"
          rows={[...byYear.entries()].sort().map(([y, n]) => [y, String(n)])}
        />
        <MiniTable
          title="Répartition par catégorie"
          rows={[...byCategorie.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .map(([c, v]) => [c, `${v.count} · ${fmtAmount(v.montant)}`])}
        />
      </div>

      <div style={{ marginBottom: 24 }}>
        <MiniTable
          title="Répartition par code comptable validé"
          rows={[...byCode.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .map(([c, v]) => [c, `${v.count} · ${fmtAmount(v.montant)}`])}
        />
      </div>

      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Couverture par mois</div>
        <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
          Les mois vides signalent des relevés manquants à réclamer aux banques.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {months.map((mo) => {
            const has = withMonth.has(mo);
            return (
              <div key={mo} title={mo} style={{ width: 58, padding: "6px 4px", textAlign: "center", borderRadius: 6, fontSize: 11, fontWeight: 600, background: has ? "#dcfce7" : "#fee2e2", color: has ? "#166534" : "#991b1b" }}>
                {mo}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "red" | "amber" }) {
  const color = tone === "red" ? "var(--red)" : tone === "amber" ? "var(--amber)" : "var(--text)";
  return (
    <div className="card" style={{ minWidth: 150 }}>
      <div className="muted" style={{ fontSize: 12.5 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

function MiniTable({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="card">
      <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 14 }}>{title}</div>
      {rows.length === 0 && <span className="muted" style={{ fontSize: 13 }}>—</span>}
      <table style={{ width: "100%", fontSize: 13 }}>
        <tbody>
          {rows.map(([a, b], i) => (
            <tr key={i}>
              <td style={{ padding: "3px 0", color: "var(--muted)" }}>{a}</td>
              <td style={{ padding: "3px 0", textAlign: "right", fontWeight: 600 }}>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
