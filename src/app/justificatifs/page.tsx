"use client";

import Shell from "@/components/Shell";

export default function JustificatifsPage() {
  return (
    <Shell>
      <h1 className="page">Justificatifs</h1>
      <p className="sub">Dépôt manuel et rattachement</p>
      <div className="card muted">
        Le dépôt de justificatifs nécessite <strong>Firebase Storage</strong>,
        pas encore activé sur le projet. Active-le dans la console
        (Storage → « Commencer »), puis je branche l&apos;upload, le
        rattachement manuel et les statuts.
      </div>
    </Shell>
  );
}
