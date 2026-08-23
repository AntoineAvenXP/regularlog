"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  UploadCloud,
  FileText,
  Image as ImageIcon,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Sparkles,
} from "lucide-react";
import { SectionHeader } from "@/components/PageHeader";
import { COL, createOwned } from "@/lib/db";
import { extractStatementAI, type AiDetectedAccount } from "@/lib/aiExtract";
import { fingerprint, fmtAmount, parseDate } from "@/lib/parsing";
import { hashFile, weakKey, writeImport, type TxDraft } from "@/lib/importWrite";
import { isPdf } from "@/lib/storage";
import type { BankAccount, Entity } from "@/lib/types";

const MAX_FILES = 100;
const CREATE = "__create__";

type Status = "pending" | "processing" | "done" | "error" | "duplicate";

interface EditRow {
  date: string;
  libelle: string;
  montant: string;
  include: boolean;
}

interface QueueItem {
  id: string;
  file: File;
  hash?: string;
  status: Status;
  error?: string;
  truncated?: boolean;
  detected?: AiDetectedAccount | null;
  resolvedAccountId: string; // "" tant que non rattaché
  rows: EditRow[];
  expanded: boolean;
}

const norm = (s: string): string =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");

const iban4 = (iban?: string | null): string | null => {
  if (!iban) return null;
  const digits = iban.replace(/\s/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
};

let seq = 0;
const nextId = () => `q${++seq}_${performance.now().toFixed(0)}`;

/**
 * Import de relevés par l'IA — jusqu'à 100 fichiers d'un coup (PDF / images).
 * Les fichiers sont traités les uns après les autres : Claude détecte le compte
 * (banque / IBAN / titulaire) et extrait les opérations, qu'on rattache
 * automatiquement au bon compte Regularlog puis qu'on valide après relecture.
 */
export default function StatementImport({
  entities,
  accounts,
  fpByAccount,
  bridgeByAccount,
  existingFileHashes,
  onImported,
  onAccountsChanged,
}: {
  entities: Entity[];
  accounts: BankAccount[];
  fpByAccount: Record<string, Set<string>>;
  bridgeByAccount: Record<string, Map<string, string>>;
  existingFileHashes: Set<string>;
  onImported: (n: number) => void;
  onAccountsChanged: (newAccountId?: string) => void;
}) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState(false);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [newEntityId, setNewEntityId] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const patch = useCallback((id: string, p: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, ...p } : q)));
  }, []);

  /** Rattache automatiquement un compte détecté à un compte existant. */
  const autoMatch = useCallback(
    (det: AiDetectedAccount | null): string => {
      if (!det) return "";
      const four = iban4(det.iban);
      if (four) {
        const byIban = accounts.find((a) => iban4(a.ibanPartiel) === four);
        if (byIban) return byIban.id;
      }
      if (det.banque) {
        const nb = norm(det.banque);
        if (nb) {
          const byBank = accounts.find((a) => {
            const na = norm(a.banque);
            return na && (na === nb || na.includes(nb) || nb.includes(na));
          });
          if (byBank) return byBank.id;
        }
      }
      return "";
    },
    [accounts]
  );

  async function runQueue(ids: string[]) {
    setRunning(true);
    for (const id of ids) {
      const item = queueRef.current.find((q) => q.id === id);
      if (!item) continue;
      patch(id, { status: "processing" });
      try {
        const { account, rows, truncated } = await extractStatementAI(item.file);
        patch(id, {
          status: "done",
          detected: account,
          truncated,
          resolvedAccountId: autoMatch(account),
          rows: rows.map((r) => ({
            date: r.date ?? "",
            libelle: r.libelle,
            montant: r.montant != null ? String(r.montant) : "",
            include: !!(r.date && r.montant != null && r.libelle),
          })),
        });
      } catch (e) {
        patch(id, { status: "error", error: (e as Error).message });
      }
    }
    setRunning(false);
  }

  // Miroir synchrone de la file pour lire l'état frais dans runQueue.
  const queueRef = useRef<QueueItem[]>([]);
  queueRef.current = queue;

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files).filter(
        (f) => isPdf(f.name) || f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)
      );
      if (arr.length === 0) return;
      const room = MAX_FILES - queueRef.current.length;
      const accepted = arr.slice(0, Math.max(0, room));

      // Empreintes déjà connues (imports passés + fichiers déjà dans la file)
      // → un relevé déjà fourni est rejeté avant tout appel IA.
      const seenHashes = new Set<string>(
        queueRef.current.map((q) => q.hash).filter(Boolean) as string[]
      );
      const items: QueueItem[] = [];
      for (const file of accepted) {
        let hash: string | undefined;
        try {
          hash = await hashFile(file);
        } catch {
          hash = undefined;
        }
        const dup = !!hash && (existingFileHashes.has(hash) || seenHashes.has(hash));
        if (hash) seenHashes.add(hash);
        items.push({
          id: nextId(),
          file,
          hash,
          status: dup ? "duplicate" : "pending",
          resolvedAccountId: "",
          rows: [],
          expanded: false,
        });
      }
      setQueue((prev) => [...prev, ...items]);
      // Traiter (IA) uniquement les nouveaux non-doublons, si rien ne tourne déjà.
      const toRun = items.filter((i) => i.status === "pending").map((i) => i.id);
      if (!running && toRun.length) runQueue(toRun);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [running, existingFileHashes]
  );

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  }

  async function createAccountFor(item: QueueItem) {
    if (!newEntityId || !item.detected) return;
    const det = item.detected;
    const id = await createOwned(COL.accounts, {
      entityId: newEntityId,
      banque: det.banque || "Banque",
      libelle: det.banque || det.titulaire || item.file.name,
      ibanPartiel: iban4(det.iban),
      source: "import" as const,
      bridgeAccountId: null,
    });
    patch(item.id, { resolvedAccountId: id });
    setCreatingFor(null);
    setNewEntityId("");
    onAccountsChanged(id);
  }

  // ---- Comptages / dédup live
  const stats = useMemo(() => {
    let ready = 0;
    let lines = 0;
    let dups = 0;
    let unassigned = 0;
    for (const it of queue) {
      if (it.status !== "done") continue;
      const acc = accounts.find((a) => a.id === it.resolvedAccountId);
      const existing = acc ? fpByAccount[acc.id] ?? new Set<string>() : null;
      const seen = new Set<string>();
      let itemLines = 0;
      for (const r of it.rows) {
        if (!r.include) continue;
        const d = parseDate(r.date);
        const m = Number(String(r.montant).replace(/\s/g, "").replace(",", "."));
        if (!d || Number.isNaN(m) || !r.libelle.trim()) continue;
        if (acc) {
          const fp = fingerprint(acc.id, d, m, r.libelle.trim());
          if ((existing && existing.has(fp)) || seen.has(fp)) {
            dups++;
            continue;
          }
          seen.add(fp);
        }
        itemLines++;
      }
      if (!acc) unassigned += itemLines;
      else {
        lines += itemLines;
        ready++;
      }
    }
    return { ready, lines, dups, unassigned };
  }, [queue, accounts, fpByAccount]);

  const pending = queue.filter((q) => q.status === "pending" || q.status === "processing").length;
  const duplicates = queue.filter((q) => q.status === "duplicate").length;

  async function validateAll() {
    setSaving(true);
    let total = 0;
    try {
      for (const it of queue) {
        if (it.status !== "done" || !it.resolvedAccountId) continue;
        const acc = accounts.find((a) => a.id === it.resolvedAccountId);
        if (!acc) continue;
        const existing = fpByAccount[acc.id] ?? new Set<string>();
        const bridgeWeak = bridgeByAccount[acc.id] ?? new Map<string, string>();
        const seen = new Set<string>();
        const drafts: TxDraft[] = [];
        const supersede = new Set<string>();
        for (const r of it.rows) {
          if (!r.include) continue;
          const d = parseDate(r.date);
          const m = Number(String(r.montant).replace(/\s/g, "").replace(",", "."));
          if (!d || Number.isNaN(m) || !r.libelle.trim()) continue;
          const fp = fingerprint(acc.id, d, m, r.libelle.trim());
          if (existing.has(fp) || seen.has(fp)) continue;
          seen.add(fp);
          drafts.push({
            dateOperation: d,
            dateValeur: null,
            libelle: r.libelle.trim(),
            montant: m,
            fp,
          });
          // L'upload prime : une opération Bridge de même compte+date+montant
          // sera supprimée au profit de cette ligne.
          const bId = bridgeWeak.get(weakKey(d, m));
          if (bId) supersede.add(bId);
        }
        if (drafts.length) {
          const pdf = isPdf(it.file.name);
          total += await writeImport({
            account: acc,
            drafts,
            origine: pdf ? "import_pdf" : "import_ocr",
            aVerifier: true,
            importKind: pdf ? "pdf" : "ocr",
            fileName: it.file.name,
            file: it.file,
            fileHash: it.hash ?? null,
            supersedeTxIds: [...supersede],
          });
        }
      }
      setQueue([]);
      onImported(total);
    } finally {
      setSaving(false);
    }
  }

  const accLabel = (a: BankAccount) => {
    const en = entities.find((e) => e.id === a.entityId)?.denomination ?? "—";
    return `${a.libelle} · ${a.banque}${a.ibanPartiel ? ` · …${a.ibanPartiel}` : ""} · ${en}`;
  };

  const detectedLabel = (det: AiDetectedAccount | null | undefined) => {
    if (!det) return "compte non détecté";
    const bits = [det.banque, det.iban ? `…${iban4(det.iban)}` : null, det.periode].filter(Boolean);
    return bits.length ? bits.join(" · ") : "compte non détecté";
  };

  return (
    <section className="card">
      <SectionHeader icon={Sparkles} title="Relevés bancaires (lecture IA)" />
      <p className="muted" style={{ marginTop: 0, marginBottom: 16, fontSize: 12.5 }}>
        Dépose jusqu&apos;à {MAX_FILES} relevés (PDF ou images). L&apos;IA les lit
        un par un, détecte le compte et reconstitue les opérations. Rien n&apos;est
        enregistré avant ta validation.
      </p>

      {/* --- Zone de dépôt --- */}
      <div
        className={`dropzone${drag ? " over" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        role="button"
        tabIndex={0}
      >
        <UploadCloud className="dropzone-icon" />
        <div className="dropzone-title">Glisse tes relevés ici</div>
        <div className="dropzone-sub">
          ou <span className="dropzone-link">parcours tes fichiers</span> — PDF, JPEG, PNG
          {accounts.length === 0 && " · crée d'abord une entité dans Paramètres"}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {queue.length > 0 && (
        <>
          {/* --- Barre de synthèse --- */}
          <div className="toolbar" style={{ marginTop: 16 }}>
            <span>
              <strong>{queue.length}</strong> fichier(s)
            </span>
            {pending > 0 && (
              <span style={{ color: "var(--muted)" }}>
                <Loader2 size={13} style={{ verticalAlign: "-2px" }} className="spin" />{" "}
                <strong>{pending}</strong> en lecture…
              </span>
            )}
            <span style={{ color: "var(--green-dark)" }}>
              <strong>{stats.lines}</strong> ligne(s) à importer
            </span>
            {stats.dups > 0 && (
              <span style={{ color: "var(--amber)" }}>
                <strong>{stats.dups}</strong> doublon(s) ignoré(s)
              </span>
            )}
            {stats.unassigned > 0 && (
              <span style={{ color: "var(--red)" }}>
                <strong>{stats.unassigned}</strong> ligne(s) sans compte rattaché
              </span>
            )}
            {duplicates > 0 && (
              <span style={{ color: "var(--amber)" }}>
                <strong>{duplicates}</strong> relevé(s) déjà importé(s), rejeté(s)
              </span>
            )}
            <button
              className="btn secondary"
              style={{ marginLeft: "auto" }}
              disabled={running || saving}
              onClick={() => setQueue([])}
            >
              <Trash2 />
              Vider
            </button>
            <button
              className="btn"
              disabled={running || saving || stats.lines === 0}
              onClick={validateAll}
            >
              {saving ? "Import…" : `Valider (${stats.lines})`}
            </button>
          </div>

          {/* --- Liste des fichiers --- */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {queue.map((it) => (
              <FileCard
                key={it.id}
                item={it}
                accounts={accounts}
                entities={entities}
                accLabel={accLabel}
                detectedLabel={detectedLabel}
                creatingFor={creatingFor}
                newEntityId={newEntityId}
                onSetResolved={(v) => {
                  if (v === CREATE) {
                    setCreatingFor(it.id);
                  } else {
                    setCreatingFor((c) => (c === it.id ? null : c));
                    patch(it.id, { resolvedAccountId: v });
                  }
                }}
                onSetNewEntity={setNewEntityId}
                onCreateAccount={() => createAccountFor(it)}
                onToggleExpand={() => patch(it.id, { expanded: !it.expanded })}
                onEditRow={(idx, p) =>
                  patch(it.id, {
                    rows: it.rows.map((r, j) => (j === idx ? { ...r, ...p } : r)),
                  })
                }
                onRemove={() => setQueue((prev) => prev.filter((q) => q.id !== it.id))}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function statusIcon(s: Status) {
  if (s === "processing")
    return <Loader2 size={18} className="spin" style={{ color: "var(--green)" }} />;
  if (s === "done")
    return <CheckCircle2 size={18} style={{ color: "var(--green)" }} />;
  if (s === "error")
    return <AlertCircle size={18} style={{ color: "var(--red)" }} />;
  if (s === "duplicate")
    return <AlertCircle size={18} style={{ color: "var(--amber)" }} />;
  return <Loader2 size={18} style={{ color: "var(--muted-2)" }} />;
}

function FileCard({
  item,
  accounts,
  entities,
  accLabel,
  detectedLabel,
  creatingFor,
  newEntityId,
  onSetResolved,
  onSetNewEntity,
  onCreateAccount,
  onToggleExpand,
  onEditRow,
  onRemove,
}: {
  item: QueueItem;
  accounts: BankAccount[];
  entities: Entity[];
  accLabel: (a: BankAccount) => string;
  detectedLabel: (d: AiDetectedAccount | null | undefined) => string;
  creatingFor: string | null;
  newEntityId: string;
  onSetResolved: (v: string) => void;
  onSetNewEntity: (v: string) => void;
  onCreateAccount: () => void;
  onToggleExpand: () => void;
  onEditRow: (idx: number, p: Partial<EditRow>) => void;
  onRemove: () => void;
}) {
  const pdf = isPdf(item.file.name);
  const nbIncluded = item.rows.filter((r) => r.include).length;
  const canCreate = !!(item.detected && (item.detected.banque || item.detected.iban));
  const isCreating = creatingFor === item.id;

  return (
    <div className="filecard">
      <div className="filecard-head">
        <span className="filecard-status">{statusIcon(item.status)}</span>
        <span className="filecard-type">
          {pdf ? <FileText size={16} /> : <ImageIcon size={16} />}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="filecard-name" title={item.file.name}>
            {item.file.name}
          </div>
          <div className="filecard-meta">
            {item.status === "processing" && "Lecture par l'IA…"}
            {item.status === "pending" && "En attente…"}
            {item.status === "duplicate" && (
              <span style={{ color: "var(--amber)" }}>
                Relevé déjà importé — rejeté (aucune lecture IA).
              </span>
            )}
            {item.status === "error" && (
              <span style={{ color: "var(--red)" }}>{item.error}</span>
            )}
            {item.status === "done" && (
              <>
                {detectedLabel(item.detected)} · <strong>{item.rows.length}</strong> opération(s)
                {item.truncated && (
                  <span style={{ color: "var(--amber)" }}> · relevé long, vérifie la fin</span>
                )}
              </>
            )}
          </div>
        </div>

        {item.status === "done" && (
          <div className="filecard-account">
            <select
              value={
                item.resolvedAccountId || (isCreating ? CREATE : "")
              }
              onChange={(e) => onSetResolved(e.target.value)}
            >
              <option value="">— compte non rattaché —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accLabel(a)}
                </option>
              ))}
              {canCreate && (
                <option value={CREATE}>
                  ＋ Créer « {item.detected?.banque || "compte"}
                  {item.detected?.iban ? ` …${iban4(item.detected.iban)}` : ""} »
                </option>
              )}
            </select>
          </div>
        )}

        {item.status === "done" && (
          <button className="filecard-expand" onClick={onToggleExpand} title="Voir les lignes">
            {item.expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
            <span>{nbIncluded}</span>
          </button>
        )}
        {(item.status === "error" || item.status === "done" || item.status === "duplicate") && (
          <button className="filecard-remove" onClick={onRemove} title="Retirer">
            <Trash2 size={15} />
          </button>
        )}
      </div>

      {/* Création de compte inline */}
      {isCreating && (
        <div className="filecard-create">
          <span className="muted" style={{ fontSize: 12.5 }}>
            Nouveau compte « {item.detected?.banque || "Banque"}
            {item.detected?.iban ? ` …${iban4(item.detected.iban)}` : ""} » →
          </span>
          <select value={newEntityId} onChange={(e) => onSetNewEntity(e.target.value)}>
            <option value="">— entité de rattachement —</option>
            {entities.map((en) => (
              <option key={en.id} value={en.id}>
                {en.denomination}
              </option>
            ))}
          </select>
          <button className="btn secondary" disabled={!newEntityId} onClick={onCreateAccount}>
            <Plus />
            Créer le compte
          </button>
        </div>
      )}

      {/* Lignes éditables */}
      {item.expanded && item.status === "done" && (
        <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto", marginTop: 4 }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Import ?</th>
                <th>Date</th>
                <th>Libellé</th>
                <th>Montant</th>
              </tr>
            </thead>
            <tbody>
              {item.rows.map((r, i) => {
                const d = parseDate(r.date);
                const m = Number(String(r.montant).replace(/\s/g, "").replace(",", "."));
                const valid = !!(d && !Number.isNaN(m) && r.libelle.trim());
                return (
                  <tr key={i} style={{ opacity: valid ? 1 : 0.6 }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={r.include}
                        onChange={(e) => onEditRow(i, { include: e.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        value={r.date}
                        onChange={(e) => onEditRow(i, { date: e.target.value })}
                        style={{ maxWidth: 110 }}
                        placeholder="2024-01-15"
                      />
                    </td>
                    <td>
                      <input
                        value={r.libelle}
                        onChange={(e) => onEditRow(i, { libelle: e.target.value })}
                        style={{ maxWidth: 340, width: 340 }}
                      />
                    </td>
                    <td>
                      <input
                        value={r.montant}
                        onChange={(e) => onEditRow(i, { montant: e.target.value })}
                        style={{ maxWidth: 90 }}
                        placeholder="-12.34"
                      />
                      {valid && (
                        <span
                          className="muted"
                          style={{ marginLeft: 6, fontSize: 11, color: m < 0 ? "var(--red)" : "var(--green)" }}
                        >
                          {fmtAmount(m)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
