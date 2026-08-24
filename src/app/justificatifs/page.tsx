"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Folder,
  FolderPlus,
  FileBarChart,
  FileText,
  Download,
  Trash2,
  Inbox,
} from "lucide-react";
import Shell from "@/components/Shell";
import { PageHeader, SectionHeader } from "@/components/PageHeader";
import { COL, createOwned, deleteOwned, listOwned, updateOwned } from "@/lib/db";
import type {
  BankAccount,
  Category,
  DocCertification,
  Dossier,
  Entity,
  GeneratedDocument,
  Justificatif,
  Transaction,
  TransactionOrigin,
  Usage,
} from "@/lib/types";
import {
  deleteFile,
  documentPath,
  fileUrl,
  isImage,
  isPdf,
  justifPath,
  uploadBlob,
  uploadFile,
} from "@/lib/storage";
import { fmtAmount } from "@/lib/parsing";
import { accountUsageMap, entityTypeMap, usageOf } from "@/lib/usage";
import { getBrandAssets } from "@/lib/brandAssets";
import { generateTransactionsPdf, type PdfRow } from "@/lib/pdfReport";
import { useAuth } from "@/lib/auth";

const UPLOAD_ORIGINS = new Set<TransactionOrigin>([
  "import_pdf",
  "import_ocr",
  "import_csv",
  "import_excel",
]);

function sourceLabel(o: TransactionOrigin): string {
  if (o === "bridge") return "Bridge";
  if (o === "saisie_manuelle") return "Manuel";
  return "Relevé importé";
}

function certificationOf(rows: Transaction[]): DocCertification {
  if (rows.some((t) => UPLOAD_ORIGINS.has(t.origine))) return "upload";
  if (rows.length > 0 && rows.every((t) => t.origine === "bridge")) return "bridge";
  return "manuel";
}

async function shortHash(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16)
    .toUpperCase();
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

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
  const [entities, setEntities] = useState<Entity[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [dossiers, setDossiers] = useState<Dossier[]>([]);
  const [documents, setDocuments] = useState<GeneratedDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  // dossier sélectionné : id réel, ou "all" / "none"
  const [selDossier, setSelDossier] = useState<string>("all");

  async function reload() {
    const [j, t, e, a, cat, dos, docs] = await Promise.all([
      listOwned<Justificatif>(COL.justificatifs),
      listOwned<Transaction>(COL.transactions),
      listOwned<Entity>(COL.entities),
      listOwned<BankAccount>(COL.accounts),
      listOwned<Category>(COL.categories),
      listOwned<Dossier>(COL.dossiers),
      listOwned<GeneratedDocument>(COL.documents),
    ]);
    setJustifs(j.sort((x, y) => ((x.date ?? "") < (y.date ?? "") ? 1 : -1)));
    setTx(t);
    setEntities(e);
    setAccounts(a);
    setCategories(cat.sort((x, y) => (x.ordre ?? 0) - (y.ordre ?? 0) || x.nom.localeCompare(y.nom)));
    setDossiers(dos.sort((x, y) => x.nom.localeCompare(y.nom)));
    setDocuments(docs.sort((x, y) => (x.reference < y.reference ? 1 : -1)));
    setLoading(false);
  }
  useEffect(() => {
    if (user) reload();
  }, [user]);

  const typeById = useMemo(() => entityTypeMap(entities), [entities]);
  const accUsageById = useMemo(() => accountUsageMap(accounts), [accounts]);
  const entName = (id: string) => entities.find((e) => e.id === id)?.denomination ?? "—";
  const accName = (id: string) => accounts.find((a) => a.id === id)?.libelle ?? "—";

  // ---------- Justificatifs (upload + rattachement) ----------
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
  async function removeJustif(j: Justificatif) {
    if (!window.confirm(`Supprimer « ${j.nomOrigine} » ?`)) return;
    for (const txId of j.transactionIds ?? [])
      await updateOwned(COL.transactions, txId, { justificatifStatus: "manquant" });
    if (j.storagePath) await deleteFile(j.storagePath);
    await deleteOwned(COL.justificatifs, j.id);
    reload();
  }

  // ---------- Dossiers ----------
  async function addDossier() {
    const nom = window.prompt("Nom du dossier :");
    if (!nom || !nom.trim()) return;
    const id = await createOwned(COL.dossiers, { nom: nom.trim() });
    setSelDossier(id);
    reload();
  }
  async function removeDossier(d: Dossier) {
    if (!window.confirm(`Supprimer le dossier « ${d.nom} » ? Les documents ne sont pas supprimés (ils passent « sans dossier »).`)) return;
    for (const doc of documents.filter((x) => x.dossierId === d.id))
      await updateOwned(COL.documents, doc.id, { dossierId: null });
    await deleteOwned(COL.dossiers, d.id);
    if (selDossier === d.id) setSelDossier("all");
    reload();
  }

  // ---------- Documents générés ----------
  async function moveDoc(doc: GeneratedDocument, dossierId: string | null) {
    await updateOwned(COL.documents, doc.id, { dossierId });
    reload();
  }
  async function openDoc(doc: GeneratedDocument) {
    if (!doc.storagePath) return;
    try {
      const url = await fileUrl(doc.storagePath);
      window.open(url, "_blank");
    } catch {
      /* fichier indisponible */
    }
  }
  async function removeDoc(doc: GeneratedDocument) {
    if (!window.confirm(`Supprimer le document « ${doc.reference} » ?`)) return;
    if (doc.storagePath) await deleteFile(doc.storagePath);
    await deleteOwned(COL.documents, doc.id);
    reload();
  }

  const shownDocs = useMemo(() => {
    if (selDossier === "all") return documents;
    if (selDossier === "none") return documents.filter((d) => !d.dossierId);
    return documents.filter((d) => d.dossierId === selDossier);
  }, [documents, selDossier]);

  if (loading) return <p className="muted">Chargement…</p>;

  const dossierName = (id?: string | null) =>
    id ? dossiers.find((d) => d.id === id)?.nom ?? "—" : "Sans dossier";

  return (
    <div>
      <PageHeader
        title="Justificatifs & documents"
        subtitle="Dépose tes justificatifs, génère des documents PDF de transactions et classe-les par dossier."
      />

      <div className="doclayout">
        {/* -------- Menu latéral des dossiers -------- */}
        <aside className="dossier-menu">
          <div className="dossier-menu-head">
            <span>Dossiers</span>
            <button className="icon-btn" onClick={addDossier} title="Nouveau dossier">
              <FolderPlus size={16} />
            </button>
          </div>
          <button
            className={`dossier-item${selDossier === "all" ? " active" : ""}`}
            onClick={() => setSelDossier("all")}
          >
            <Inbox size={15} /> Tous
            <span className="dossier-count">{documents.length}</span>
          </button>
          {dossiers.map((d) => (
            <div key={d.id} className={`dossier-item${selDossier === d.id ? " active" : ""}`}>
              <button className="dossier-item-main" onClick={() => setSelDossier(d.id)}>
                <Folder size={15} /> {d.nom}
                <span className="dossier-count">
                  {documents.filter((x) => x.dossierId === d.id).length}
                </span>
              </button>
              <button className="dossier-del" onClick={() => removeDossier(d)} title="Supprimer">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <button
            className={`dossier-item${selDossier === "none" ? " active" : ""}`}
            onClick={() => setSelDossier("none")}
          >
            <Folder size={15} /> Sans dossier
            <span className="dossier-count">{documents.filter((x) => !x.dossierId).length}</span>
          </button>
        </aside>

        {/* -------- Contenu principal -------- */}
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
          <Generator
            tx={tx}
            entities={entities}
            accounts={accounts}
            categories={categories}
            typeById={typeById}
            accUsageById={accUsageById}
            accName={accName}
            entName={entName}
            targetDossierId={selDossier === "all" || selDossier === "none" ? null : selDossier}
            targetDossierName={
              selDossier === "all" || selDossier === "none" ? null : dossierName(selDossier)
            }
            onGenerated={reload}
          />

          {/* Liste des documents générés */}
          <section className="card">
            <SectionHeader icon={FileBarChart} title="Documents générés" />
            {shownDocs.length === 0 && (
              <div className="empty">Aucun document dans cette vue.</div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {shownDocs.map((doc) => (
                <div key={doc.id} className="docrow">
                  <span className="docrow-icon">
                    <FileText size={18} />
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="docrow-title">{doc.titre}</div>
                    <div className="docrow-meta">
                      {doc.reference} · {doc.nbTransactions} op. · solde {fmtAmount(
                        doc.totalCredit + doc.totalDebit
                      )}
                    </div>
                  </div>
                  <CertifBadge kind={doc.certification} />
                  <select
                    value={doc.dossierId ?? ""}
                    onChange={(e) => moveDoc(doc, e.target.value || null)}
                    title="Classer dans un dossier"
                  >
                    <option value="">Sans dossier</option>
                    {dossiers.map((d) => (
                      <option key={d.id} value={d.id}>{d.nom}</option>
                    ))}
                  </select>
                  <button className="icon-btn" onClick={() => openDoc(doc)} title="Ouvrir">
                    <Download size={16} />
                  </button>
                  <button className="icon-btn danger" onClick={() => removeDoc(doc)} title="Supprimer">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* Justificatifs (upload + rattachement) */}
          <section className="card">
            <SectionHeader icon={FileText} title="Justificatifs" />
            <label className="field" style={{ maxWidth: 420, marginBottom: 8 }}>
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
            {uploading && <p className="muted" style={{ marginTop: 4 }}>Envoi en cours…</p>}

            {justifs.length === 0 && <p className="muted">Aucun justificatif.</p>}
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
              {justifs.map((j) => (
                <JustifCard
                  key={j.id}
                  j={j}
                  tx={tx}
                  onPatch={(data) => updateOwned(COL.justificatifs, j.id, data).then(reload)}
                  onAttach={(t) => attach(j, t)}
                  onDetach={(txId) => detach(j, txId)}
                  onRemove={() => removeJustif(j)}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function CertifBadge({ kind }: { kind: DocCertification }) {
  const map: Record<DocCertification, { label: string; cls: string }> = {
    bridge: { label: "Bridge", cls: "rattache" },
    upload: { label: "Fichier fourni", cls: "verif" },
    manuel: { label: "Manuel", cls: "sans_objet" },
  };
  const { label, cls } = map[kind];
  return <span className={`badge ${cls}`}>{label}</span>;
}

// ---------------- Générateur de PDF ----------------
function Generator({
  tx,
  entities,
  accounts,
  categories,
  typeById,
  accUsageById,
  accName,
  entName,
  targetDossierId,
  targetDossierName,
  onGenerated,
}: {
  tx: Transaction[];
  entities: Entity[];
  accounts: BankAccount[];
  categories: Category[];
  typeById: Map<string, Entity["type"]>;
  accUsageById: Map<string, Usage>;
  accName: (id: string) => string;
  entName: (id: string) => string;
  targetDossierId: string | null;
  targetDossierName: string | null;
  onGenerated: () => void;
}) {
  const [gEntity, setGEntity] = useState("");
  const [gAccount, setGAccount] = useState("");
  const [gCat, setGCat] = useState("");
  const [gStart, setGStart] = useState("");
  const [gEnd, setGEnd] = useState("");
  const [gUsage, setGUsage] = useState<"tout" | "pro" | "perso">("tout");
  const [groupBy, setGroupBy] = useState<"categorie" | "compte" | "mois">("categorie");
  const [busy, setBusy] = useState(false);

  const accountsForEntity = gEntity ? accounts.filter((a) => a.entityId === gEntity) : accounts;

  const rows = useMemo(
    () =>
      tx.filter((t) => {
        if (gEntity && t.entityId !== gEntity) return false;
        if (gAccount && t.bankAccountId !== gAccount) return false;
        if (gCat === "__none__" && (t.categorie ?? "") !== "") return false;
        if (gCat && gCat !== "__none__" && t.categorie !== gCat) return false;
        const mo = (t.dateOperation || "").slice(0, 7);
        if (gStart && mo < gStart) return false;
        if (gEnd && mo > gEnd) return false;
        if (gUsage !== "tout" && usageOf(t, accUsageById, typeById) !== gUsage) return false;
        return true;
      }),
    [tx, gEntity, gAccount, gCat, gStart, gEnd, gUsage, accUsageById, typeById]
  );

  const groupKeyOf = (t: Transaction) =>
    groupBy === "categorie"
      ? t.categorie || "(sans catégorie)"
      : groupBy === "compte"
      ? accName(t.bankAccountId)
      : (t.dateOperation || "").slice(0, 7) || "(sans date)";

  async function generate() {
    if (rows.length === 0) {
      window.alert("Aucune transaction ne correspond à ces filtres.");
      return;
    }
    setBusy(true);
    try {
      const assets = await getBrandAssets();
      const certification = certificationOf(rows);

      const sorted = [...rows].sort((a, b) => {
        const ka = groupKeyOf(a);
        const kb = groupKeyOf(b);
        if (ka !== kb) return ka < kb ? -1 : 1;
        return (a.dateOperation || "") < (b.dateOperation || "") ? -1 : 1;
      });
      const pdfRows: PdfRow[] = sorted.map((t) => ({
        date: t.dateOperation,
        libelle: t.libelleBrut,
        categorie: t.categorie || "—",
        compte: accName(t.bankAccountId),
        source: sourceLabel(t.origine),
        montant: t.montant,
        groupKey: groupKeyOf(t),
      }));

      const debit = rows.filter((t) => t.montant < 0).reduce((s, t) => s + t.montant, 0);
      const credit = rows.filter((t) => t.montant > 0).reduce((s, t) => s + t.montant, 0);
      const totals = { nb: rows.length, debit, credit, net: debit + credit };

      const now = new Date();
      const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
      const rand = Math.random().toString(16).slice(2, 6).toUpperCase();
      const reference = `RL-${stamp}-${rand}`;
      const integrity = await shortHash(
        rows.map((t) => t.fingerprint).join("|") + reference
      );

      const groupByLabel =
        groupBy === "categorie" ? "Catégorie" : groupBy === "compte" ? "Compte" : "Mois";
      const period =
        gStart || gEnd ? `${gStart || "…"} → ${gEnd || "…"}` : "Tout l'historique";
      const filterSummary = [
        { label: "Entité", value: gEntity ? entName(gEntity) : "Toutes" },
        { label: "Compte", value: gAccount ? accName(gAccount) : "Tous" },
        { label: "Catégorie", value: gCat === "__none__" ? "Sans catégorie" : gCat || "Toutes" },
        { label: "Période", value: period },
        { label: "Vue", value: gUsage === "tout" ? "Tout" : gUsage === "pro" ? "Pro" : "Perso" },
        { label: "Regroupement", value: groupByLabel },
      ];

      const titre = "Relevé de transactions";
      const generatedAtLabel = now.toLocaleString("fr-FR", {
        dateStyle: "long",
        timeStyle: "short",
      });

      const blob = await generateTransactionsPdf({
        titre,
        reference,
        generatedAtLabel,
        filterSummary,
        groupByLabel,
        rows: pdfRows,
        totals,
        certification,
        integrity,
        assets,
      });

      const docId = await createOwned(COL.documents, {
        titre,
        reference,
        storagePath: "",
        dossierId: targetDossierId,
        certification,
        groupBy,
        filtres: {
          entityId: gEntity || null,
          bankAccountId: gAccount || null,
          categorie: gCat === "__none__" ? "(sans catégorie)" : gCat || null,
          periodeStart: gStart || null,
          periodeEnd: gEnd || null,
          usage: gUsage,
        },
        nbTransactions: totals.nb,
        totalDebit: totals.debit,
        totalCredit: totals.credit,
        integrity,
      });
      const path = documentPath(docId, `${reference}.pdf`);
      await uploadBlob(path, blob, "application/pdf");
      await updateOwned(COL.documents, docId, { storagePath: path });

      downloadBlob(blob, `${reference}.pdf`);
      onGenerated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <SectionHeader icon={FileBarChart} title="Générer un document" />
      <p className="muted" style={{ marginTop: 0, marginBottom: 14, fontSize: 12.5 }}>
        Liste les transactions filtrées dans un PDF de marque, regroupées par
        catégorie, compte ou mois. Classé dans{" "}
        <strong>{targetDossierName ?? "aucun dossier (sélectionne-en un à gauche)"}</strong>.
      </p>
      <div className="row">
        <div className="field">
          <label>Entité</label>
          <select
            value={gEntity}
            onChange={(e) => {
              setGEntity(e.target.value);
              setGAccount("");
            }}
          >
            <option value="">Toutes</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.denomination}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Compte</label>
          <select value={gAccount} onChange={(e) => setGAccount(e.target.value)}>
            <option value="">Tous</option>
            {accountsForEntity.map((a) => (
              <option key={a.id} value={a.id}>{a.libelle}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Catégorie</label>
          <select value={gCat} onChange={(e) => setGCat(e.target.value)}>
            <option value="">Toutes</option>
            <option value="__none__">Sans catégorie</option>
            {categories.map((c) => (
              <option key={c.id} value={c.nom}>{c.nom}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Vue</label>
          <select value={gUsage} onChange={(e) => setGUsage(e.target.value as typeof gUsage)}>
            <option value="tout">Tout</option>
            <option value="pro">Pro</option>
            <option value="perso">Perso</option>
          </select>
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <div className="field">
          <label>Du mois</label>
          <input type="month" value={gStart} onChange={(e) => setGStart(e.target.value)} />
        </div>
        <div className="field">
          <label>Au mois</label>
          <input type="month" value={gEnd} onChange={(e) => setGEnd(e.target.value)} />
        </div>
        <div className="field">
          <label>Regrouper par</label>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}>
            <option value="categorie">Catégorie</option>
            <option value="compte">Compte</option>
            <option value="mois">Mois</option>
          </select>
        </div>
        <div className="field" style={{ justifyContent: "flex-end" }}>
          <label>&nbsp;</label>
          <button className="btn" disabled={busy} onClick={generate}>
            <FileBarChart size={16} />
            {busy ? "Génération…" : `Générer le PDF (${rows.length})`}
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------------- Carte justificatif (inchangée) ----------------
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
    <div style={{ display: "flex", gap: 16, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 14 }}>
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
