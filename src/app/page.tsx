"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { COL, listOwned } from "@/lib/db";
import type { Transaction } from "@/lib/types";
import { fmtAmount } from "@/lib/parsing";
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
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function Dashboard() {
  const { user } = useAuth();
  const [tx, setTx] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      setTx(await listOwned<Transaction>(COL.transactions));
      setLoading(false);
    })();
  }, [user]);

  if (loading) return <p className="muted">Chargement…</p>;

  const sansJustif = tx.filter((t) => t.justificatifStatus === "manquant");
  const aVerifier = tx.filter((t) => t.aVerifier);
  const montantConcerne = sansJustif.reduce((s, t) => s + Math.abs(t.montant), 0);

  const withMonth = new Set(tx.map((t) => (t.dateOperation || "").slice(0, 7)));
  const months = monthsSince("2024-01");

  return (
    <div>
      <h1 className="page">Tableau de bord</h1>
      <p className="sub">Reconstitution depuis janvier 2024</p>

      <div className="row" style={{ gap: 16, marginBottom: 24 }}>
        <Stat label="Transactions" value={String(tx.length)} />
        <Stat label="Sans justificatif" value={String(sansJustif.length)} tone="red" />
        <Stat label="Montant concerné" value={fmtAmount(montantConcerne)} tone="red" />
        <Stat label="Lignes à vérifier (OCR)" value={String(aVerifier.length)} tone="amber" />
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
              <div
                key={mo}
                title={mo}
                style={{
                  width: 58,
                  padding: "6px 4px",
                  textAlign: "center",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  background: has ? "#dcfce7" : "#fee2e2",
                  color: has ? "#166534" : "#991b1b",
                }}
              >
                {mo}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "red" | "amber";
}) {
  const color =
    tone === "red" ? "var(--red)" : tone === "amber" ? "var(--amber)" : "var(--text)";
  return (
    <div className="card" style={{ minWidth: 170 }}>
      <div className="muted" style={{ fontSize: 12.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}
