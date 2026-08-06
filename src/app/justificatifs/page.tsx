"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { COL, createOwned, deleteOwned, listOwned, updateOwned } from "@/lib/db";
import type { Justificatif, Transaction } from "@/lib/types";
import {
  deleteFile,
  fileUrl,
  isImage,
  isPdf,
  justifPath,
  uploadFile,
} from "@/lib/storage";
import { fmtAmount } from "@/lib/parsing";
import { useAuth } from "@/lib/auth";

export default function JustificatifsPage() {
  return (
    <Shell>
      <Justificatifs />
    </Shell>
  );
}

function Justificatifs() {
  const { user } = useAuth();
  const [justifs, setJustifs] = useState<Justificatif[]>([]);
  const [tx, setTx] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  async function reload() {
    const [j, t] = await Promise.all([
      listOwned<Justificatif>(COL.justificatifs),
      listOwned<Transaction>(COL.transactions),
    ]);
    setJustifs(
      j.sort((a, b) => ((a.date ?? "") < (b.date ?? "") ? 1 : -1))
    );
    setTx(t);
    setLoading(false);
  }
  useEffect(() => {
    if (user) reload();
  }, [user]);

  async function onUpload(files: FileList) {
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const id = await createOwned(COL.justificatifs, {
          storagePath: "",
          nomOrigine: file.name,
          source: "upload_manuel" as const,
          date: null,
          emetteur: null,
          montant: null,
          numeroPiece: null,
          transactionIds: [] as string[],
          statut: "en_attente_validation" as const,
          notes: null,
        });
        const path = justifPath(id, file.name);
        await uploadFile(path, file);
        await updateOwned(COL.justificatifs, id, { storagePath: path });
      }
      await reload();
    } finally {
      setUploading(false);
    }
  }

  async function attach(j: Justificatif, t: Transaction) {
    const ids = Array.from(new Set([...(j.transactionIds ?? []), t.id]));
    await updateOwned(COL.justificatifs, j.id, { transactionIds: ids, statut: "valide" });
    await updateOwned(COL.transactions, t.id, { justificatifStatus: "rattache" });
    reload();
  }
  async function detach(j: Justificatif, txId: string) {
    const ids = (j.transactionIds ?? []).filter((x) => x !== txId);
    await updateOwned(COL.justificatifs, j.id, {
      transactionIds: ids,
      statut: ids.length ? "valide" : "en_attente_validation",
    });
    await updateOwned(COL.transactions, txId, { justificatifStatus: "manquant" });
    reload();
  }
  async function remove(j: Justificatif) {
    if (!window.confirm(`Supprimer « ${j.nomOrigine} » ?`)) return;
    for (const txId of j.transactionIds ?? [])
      await updateOwned(COL.transactions, txId, { justificatifStatus: "manquant" });
    if (j.storagePath) await deleteFile(j.storagePath);
    await deleteOwned(COL.justificatifs, j.id);
    reload();
  }

  if (loading) return <p className="muted">Chargement…</p>;

  return (
    <div>
      <h1 className="page">Justificatifs</h1>
      <p className="sub">Dépôt manuel, prévisualisation et rattachement</p>

      <div className="card" style={{ marginBottom: 20 }}>
        <label className="field" style={{ maxWidth: 420 }}>
          <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>
            Déposer un ou plusieurs fichiers (PDF, images…)
          </span>
          <input
            type="file"
            multiple
            accept=".pdf,image/*"
            disabled={uploading}
            onChange={(e) => e.target.files?.length && onUpload(e.target.files)}
          />
        </label>
        {uploading && <p className="muted" style={{ marginTop: 8 }}>Envoi en cours…</p>}
      </div>

      {justifs.length === 0 && <p className="muted">Aucun justificatif.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {justifs.map((j) => (
          <JustifCard
            key={j.id}
            j={j}
            tx={tx}
            onPatch={(data) => updateOwned(COL.justificatifs, j.id, data).then(reload)}
            onAttach={(t) => attach(j, t)}
            onDetach={(txId) => detach(j, txId)}
            onRemove={() => remove(j)}
          />
        ))}
      </div>
    </div>
  );
}

function JustifCard({
  j,
  tx,
  onPatch,
  onAttach,
  onDetach,
  onRemove,
}: {
  j: Justificatif;
  tx: Transaction[];
  onPatch: (data: Record<string, unknown>) => void;
  onAttach: (t: Transaction) => void;
  onDetach: (txId: string) => void;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    let alive = true;
    if (j.storagePath) fileUrl(j.storagePath).then((u) => alive && setUrl(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [j.storagePath]);

  const attached = (j.transactionIds ?? [])
    .map((id) => tx.find((t) => t.id === id))
    .filter(Boolean) as Transaction[];

  const matches = q.trim()
    ? tx
        .filter((t) => {
          const s = q.trim().toLowerCase();
          return (
            t.libelleBrut.toLowerCase().includes(s) ||
            String(t.montant).includes(s) ||
            (t.dateOperation || "").includes(s)
          );
        })
        .slice(0, 15)
    : [];

  return (
    <div className="card" style={{ display: "flex", gap: 16 }}>
      {/* Aperçu */}
      <div style={{ width: 120, flexShrink: 0 }}>
        {url && isImage(j.nomOrigine) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={j.nomOrigine} style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }} />
        ) : (
          <div style={{ width: 120, height: 120, borderRadius: 8, border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8fafc", fontSize: 12, color: "var(--muted)", textAlign: "center", padding: 8 }}>
            {isPdf(j.nomOrigine) ? "PDF" : "Fichier"}
          </div>
        )}
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="muted" style={{ fontSize: 12, textDecoration: "underline", display: "block", marginTop: 6, textAlign: "center" }}>
            Ouvrir
          </a>
        )}
      </div>

      {/* Détails */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <strong style={{ wordBreak: "break-all" }}>{j.nomOrigine}</strong>
          <span className={`badge ${j.statut === "valide" ? "rattache" : j.statut === "ecarte" ? "perdu" : "verif"}`}>
            {j.statut}
          </span>
          <button className="btn secondary" style={{ marginLeft: "auto" }} onClick={onRemove}>
            Supprimer
          </button>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <MetaInput label="Date" type="date" value={j.date ?? ""} onSave={(v) => onPatch({ date: v || null })} />
          <MetaInput label="Émetteur" value={j.emetteur ?? ""} onSave={(v) => onPatch({ emetteur: v || null })} />
          <MetaInput label="Montant" value={j.montant != null ? String(j.montant) : ""} onSave={(v) => onPatch({ montant: v ? Number(v.replace(",", ".")) : null })} />
          <MetaInput label="N° pièce" value={j.numeroPiece ?? ""} onSave={(v) => onPatch({ numeroPiece: v || null })} />
        </div>

        {/* Transactions rattachées */}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginBottom: 4 }}>
            Transactions rattachées
          </div>
          {attached.length === 0 && <span className="muted" style={{ fontSize: 13 }}>Aucune.</span>}
          {attached.map((t) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "2px 0" }}>
              <span>{t.dateOperation} · {t.libelleBrut} · {fmtAmount(t.montant)}</span>
              <button onClick={() => onDetach(t.id)} style={{ background: "none", border: "none", color: "var(--red)" }}>détacher</button>
            </div>
          ))}

          {!attachOpen ? (
            <button className="btn" style={{ marginTop: 8 }} onClick={() => setAttachOpen(true)}>
              Rattacher à une transaction
            </button>
          ) : (
            <div style={{ marginTop: 8 }}>
              <input
                autoFocus
                placeholder="Rechercher (libellé, montant, date)…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                style={{ padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8, width: "100%", maxWidth: 460 }}
              />
              <div style={{ marginTop: 6 }}>
                {matches.map((t) => (
                  <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "3px 0" }}>
                    <span style={{ flex: 1 }}>{t.dateOperation} · {t.libelleBrut} · {fmtAmount(t.montant)}</span>
                    <button className="btn" onClick={() => { onAttach(t); setAttachOpen(false); setQ(""); }}>
                      Rattacher
                    </button>
                  </div>
                ))}
                {q.trim() && matches.length === 0 && <span className="muted" style={{ fontSize: 13 }}>Aucune transaction.</span>}
              </div>
              <button className="btn secondary" style={{ marginTop: 6 }} onClick={() => { setAttachOpen(false); setQ(""); }}>
                Fermer
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetaInput({
  label,
  value,
  onSave,
  type,
}: {
  label: string;
  value: string;
  onSave: (v: string) => void;
  type?: string;
}) {
  return (
    <div className="field" style={{ width: type === "date" ? 150 : 140 }}>
      <label>{label}</label>
      <input
        type={type ?? "text"}
        defaultValue={value}
        onBlur={(e) => {
          if (e.target.value !== value) onSave(e.target.value.trim());
        }}
      />
    </div>
  );
}
