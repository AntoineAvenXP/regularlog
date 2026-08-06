"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { COL, listOwned, updateOwned } from "@/lib/db";
import type {
  Justificatif,
  ReconciliationProposal,
  Transaction,
} from "@/lib/types";
import { fileUrl, isImage } from "@/lib/storage";
import { fmtAmount } from "@/lib/parsing";
import { useAuth } from "@/lib/auth";

export default function ValidationPage() {
  return (
    <Shell>
      <Validation />
    </Shell>
  );
}

function Validation() {
  const { user } = useAuth();
  const [props, setProps] = useState<ReconciliationProposal[]>([]);
  const [justifs, setJustifs] = useState<Record<string, Justificatif>>({});
  const [txs, setTxs] = useState<Record<string, Transaction>>({});
  const [allTx, setAllTx] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  async function reload() {
    const [p, j, t] = await Promise.all([
      listOwned<ReconciliationProposal>(COL.reconciliations),
      listOwned<Justificatif>(COL.justificatifs),
      listOwned<Transaction>(COL.transactions),
    ]);
    setProps(p.filter((x) => x.statut === "en_attente").sort((a, b) => b.score - a.score));
    setJustifs(Object.fromEntries(j.map((x) => [x.id, x])));
    setTxs(Object.fromEntries(t.map((x) => [x.id, x])));
    setAllTx(t);
    setLoading(false);
  }
  useEffect(() => {
    if (user) reload();
  }, [user]);

  async function validate(p: ReconciliationProposal, txId: string) {
    const j = justifs[p.justificatifId];
    const ids = Array.from(new Set([...(j?.transactionIds ?? []), txId]));
    await updateOwned(COL.justificatifs, p.justificatifId, { transactionIds: ids, statut: "valide" });
    await updateOwned(COL.transactions, txId, { justificatifStatus: "rattache" });
    await updateOwned(COL.reconciliations, p.id, { statut: "valide" });
    reload();
  }
  async function discard(p: ReconciliationProposal) {
    await updateOwned(COL.reconciliations, p.id, { statut: "ecarte" });
    reload();
  }

  if (loading) return <p className="muted">Chargement…</p>;

  return (
    <div>
      <h1 className="page">File de validation</h1>
      <p className="sub">
        Propositions de rapprochement (justificatifs reçus par mail). Aucun
        rattachement n&apos;est appliqué sans ta validation.
      </p>

      {props.length === 0 && (
        <div className="card muted">Aucune proposition en attente.</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {props.map((p) => (
          <ProposalCard
            key={p.id}
            p={p}
            justif={justifs[p.justificatifId]}
            candidate={txs[p.transactionId]}
            allTx={allTx}
            onValidate={(txId) => validate(p, txId)}
            onDiscard={() => discard(p)}
          />
        ))}
      </div>
    </div>
  );
}

function ProposalCard({
  p,
  justif,
  candidate,
  allTx,
  onValidate,
  onDiscard,
}: {
  p: ReconciliationProposal;
  justif?: Justificatif;
  candidate?: Transaction;
  allTx: Transaction[];
  onValidate: (txId: string) => void;
  onDiscard: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [correct, setCorrect] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    let alive = true;
    if (justif?.storagePath) fileUrl(justif.storagePath).then((u) => alive && setUrl(u)).catch(() => {});
    return () => { alive = false; };
  }, [justif?.storagePath]);

  const matches = q.trim()
    ? allTx
        .filter((t) => {
          const s = q.trim().toLowerCase();
          return t.libelleBrut.toLowerCase().includes(s) || String(t.montant).includes(s) || (t.dateOperation || "").includes(s);
        })
        .slice(0, 12)
    : [];

  return (
    <div className="card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
      {/* Justificatif */}
      <div>
        <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginBottom: 6 }}>Justificatif</div>
        {url && justif && isImage(justif.nomOrigine) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={justif.nomOrigine} style={{ maxWidth: "100%", maxHeight: 220, borderRadius: 8, border: "1px solid var(--border)" }} />
        ) : (
          <div className="muted">{justif?.nomOrigine ?? "—"}{url && <> · <a href={url} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>Ouvrir</a></>}</div>
        )}
        <div style={{ fontSize: 13, marginTop: 8 }}>
          <div><strong>Date :</strong> {justif?.date ?? "—"}</div>
          <div><strong>Montant :</strong> {justif?.montant != null ? fmtAmount(justif.montant) : "—"}</div>
          <div><strong>Émetteur :</strong> {justif?.emetteur ?? "—"}</div>
        </div>
      </div>

      {/* Transaction candidate + actions */}
      <div>
        <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginBottom: 6 }}>
          Transaction candidate · confiance {Math.round(p.score * 100)} %
        </div>
        {candidate ? (
          <div className="card" style={{ background: "#f8fafc" }}>
            <div><strong>{candidate.dateOperation}</strong> · {fmtAmount(candidate.montant)}</div>
            <div style={{ fontSize: 13 }}>{candidate.libelleBrut}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{p.motif}</div>
          </div>
        ) : (
          <div className="muted">Transaction introuvable.</div>
        )}

        {!correct ? (
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={!candidate} onClick={() => candidate && onValidate(candidate.id)}>Valider</button>
            <button className="btn secondary" onClick={() => setCorrect(true)}>Corriger la cible</button>
            <button className="btn danger" onClick={onDiscard}>Écarter</button>
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            <input autoFocus placeholder="Rechercher la bonne transaction…" value={q} onChange={(e) => setQ(e.target.value)} style={{ padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8, width: "100%" }} />
            <div style={{ marginTop: 6 }}>
              {matches.map((t) => (
                <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, padding: "3px 0" }}>
                  <span style={{ flex: 1 }}>{t.dateOperation} · {t.libelleBrut} · {fmtAmount(t.montant)}</span>
                  <button className="btn" onClick={() => onValidate(t.id)}>Choisir</button>
                </div>
              ))}
            </div>
            <button className="btn secondary" style={{ marginTop: 6 }} onClick={() => { setCorrect(false); setQ(""); }}>Annuler</button>
          </div>
        )}
      </div>
    </div>
  );
}
