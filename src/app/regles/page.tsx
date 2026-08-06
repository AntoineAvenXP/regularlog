"use client";

import Shell from "@/components/Shell";

export default function ReglesPage() {
  return (
    <Shell>
      <h1 className="page">Règles</h1>
      <p className="sub">Référentiel libellé → code comptable</p>
      <div className="card muted">
        Écran prévu en <strong>Tranche 2</strong> (moteur de suggestion par
        règles). En attendant, les codes comptables se saisissent directement
        dans la table Transactions.
      </div>
    </Shell>
  );
}
