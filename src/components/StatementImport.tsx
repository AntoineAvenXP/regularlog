"use client";

import { useMemo, useRef, useState } from "react";
import {
  UploadCloud,
  FileText,
  Image as ImageIcon,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Trash2,
  Sparkles,
  Plus,
  RotateCw,
  Briefcase,
  User,
  Landmark,
} from "lucide-react";
import { SectionHeader } from "@/components/PageHeader";
import ConfirmModal from "@/components/ConfirmModal";
import { isPdf } from "@/lib/storage";
import { useStatements } from "@/lib/statementsEngine";
import type { BankAccount, Entity, Statement, StatementPart, Usage } from "@/lib/types";

const CREATE = "__create__";

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

/**
 * Afficheur de l'import de relevés. La logique (file, traitement, progression,
 * multi-comptes) vit dans StatementsProvider (monté dans le layout) → elle
 * survit à la navigation.
 */
export default function StatementImport() {
  const {
    statements,
    progress,
    accounts,
    entities,
    addFiles,
    assignAccount,
    createAccountFor,
    retry,
    remove,
  } = useStatements();

  const [drag, setDrag] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  // Édition de création de compte, clé = `${statementId}::${partKey}`.
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [newEntityId, setNewEntityId] = useState("");
  const [toDelete, setToDelete] = useState<Statement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFiles(files: FileList | File[]) {
    setRejected(await addFiles(files));
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files?.length) void onFiles(e.dataTransfer.files);
  }

  async function onAssign(st: Statement, part: StatementPart, value: string) {
    const ck = `${st.id}::${part.key}`;
    if (value === CREATE) {
      setCreatingFor(ck);
      return;
    }
    setCreatingFor((c) => (c === ck ? null : c));
    if (value) await assignAccount(st, part.key, value);
  }

  async function onCreate(st: Statement, part: StatementPart) {
    if (!newEntityId) return;
    await createAccountFor(st, part.key, newEntityId);
    setCreatingFor(null);
    setNewEntityId("");
  }

  const delCount = toDelete
    ? (toDelete.parts ?? []).reduce((s, p) => s + (p.nbImported ?? 0), 0)
    : 0;

  const working = statements.some((s) => s.status === "processing");

  // Récap des comptes détectés (tous relevés confondus).
  const detectedAccounts = useMemo(() => {
    const map = new Map<string, { banque: string | null; iban4: string | null; usage: Usage | null; matched: boolean }>();
    for (const s of statements) {
      for (const p of s.parts ?? []) {
        if (!p.detected) continue;
        const key = `${norm(p.detected.banque || "")}|${iban4(p.detected.iban) || p.key}`;
        const cur = map.get(key) ?? {
          banque: p.detected.banque,
          iban4: iban4(p.detected.iban),
          usage: p.detected.usage,
          matched: !!p.resolvedAccountId,
        };
        if (p.resolvedAccountId) cur.matched = true;
        map.set(key, cur);
      }
    }
    return [...map.values()];
  }, [statements]);

  const accLabel = (a: BankAccount) => {
    const en = entities.find((e) => e.id === a.entityId)?.denomination ?? "—";
    return `${a.libelle} · ${a.banque}${a.ibanPartiel ? ` · …${a.ibanPartiel}` : ""} · ${en}`;
  };

  return (
    <section className="card">
      <SectionHeader icon={Sparkles} title="Relevés bancaires (lecture IA)" />
      <p className="muted" style={{ marginTop: 0, marginBottom: 16, fontSize: 12.5 }}>
        Dépose tes relevés (PDF ou images). L&apos;IA détecte le(s) compte(s) — un
        même relevé peut en contenir plusieurs (numéros différents) — et les
        opérations remontent dans <strong>Transactions</strong> dès qu&apos;un compte
        est rattaché. La lecture continue même si tu changes de page.
      </p>

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
          {working && " · lecture en cours…"}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) void onFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {rejected.length > 0 && (
        <p style={{ marginTop: 10, fontSize: 12.5, color: "var(--amber)" }}>
          {rejected.length} relevé(s) déjà importé(s), ignoré(s) : {rejected.join(", ")}
        </p>
      )}

      {detectedAccounts.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
            Comptes détectés
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {detectedAccounts.map((d, i) => (
              <div key={i} className="detected-acc">
                <Landmark size={14} />
                <span>{d.banque || "Banque inconnue"}{d.iban4 ? ` · …${d.iban4}` : ""}</span>
                {d.usage && <UsageBadge usage={d.usage} />}
                <span className={`badge ${d.matched ? "rattache" : "verif"}`} style={{ marginLeft: 2 }}>
                  {d.matched ? "rattaché" : "à rattacher"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {statements.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          {statements.map((st) => (
            <StatementRow
              key={st.id}
              st={st}
              progress={progress[st.id]}
              accounts={accounts}
              entities={entities}
              accLabel={accLabel}
              creatingFor={creatingFor}
              newEntityId={newEntityId}
              onAssign={(part, v) => onAssign(st, part, v)}
              onSetNewEntity={setNewEntityId}
              onCreateAccount={(part) => onCreate(st, part)}
              onRetry={() => retry(st)}
              onRemove={() => setToDelete(st)}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!toDelete}
        title="Supprimer ce relevé ?"
        message={
          toDelete
            ? delCount > 0
              ? `« ${toDelete.fileName} » et ses ${delCount} transaction(s) importée(s) seront supprimés de Regularlog.\nCette action est irréversible.`
              : `« ${toDelete.fileName} » sera retiré de la liste.`
            : ""
        }
        confirmLabel="Supprimer"
        onConfirm={async () => {
          if (toDelete) await remove(toDelete);
          setToDelete(null);
        }}
        onCancel={() => setToDelete(null)}
      />
    </section>
  );
}

function UsageBadge({ usage }: { usage: Usage }) {
  const pro = usage === "pro";
  return (
    <span className="usage-pill" data-usage={usage} style={{ pointerEvents: "none" }}>
      {pro ? <Briefcase size={11} /> : <User size={11} />}
      {pro ? "Pro" : "Perso"}
    </span>
  );
}

function statusIcon(s: Statement["status"]) {
  if (s === "processing") return <Loader2 size={18} className="spin" style={{ color: "var(--green)" }} />;
  if (s === "imported") return <CheckCircle2 size={18} style={{ color: "var(--green)" }} />;
  if (s === "ready") return <AlertCircle size={18} style={{ color: "var(--amber)" }} />;
  if (s === "empty") return <AlertCircle size={18} style={{ color: "var(--muted-2)" }} />;
  return <AlertCircle size={18} style={{ color: "var(--red)" }} />;
}

function partLabel(det: StatementPart["detected"]): string {
  if (!det) return "Compte non identifié";
  return [det.banque, det.iban ? `…${iban4(det.iban)}` : null, det.periode].filter(Boolean).join(" · ") || "Compte détecté";
}

function StatementRow({
  st,
  progress,
  accounts,
  entities,
  accLabel,
  creatingFor,
  newEntityId,
  onAssign,
  onSetNewEntity,
  onCreateAccount,
  onRetry,
  onRemove,
}: {
  st: Statement;
  progress?: { done: number; total: number };
  accounts: BankAccount[];
  entities: Entity[];
  accLabel: (a: BankAccount) => string;
  creatingFor: string | null;
  newEntityId: string;
  onAssign: (part: StatementPart, v: string) => void;
  onSetNewEntity: (v: string) => void;
  onCreateAccount: (part: StatementPart) => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const pdf = isPdf(st.fileName);
  const parts = st.parts ?? [];
  const showParts = (st.status === "ready" || st.status === "imported") && parts.length > 0;

  return (
    <div className="filecard">
      <div className="filecard-head">
        <span className="filecard-status">{statusIcon(st.status)}</span>
        <span className="filecard-type">{pdf ? <FileText size={16} /> : <ImageIcon size={16} />}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="filecard-name" title={st.fileName}>{st.fileName}</div>
          <div className="filecard-meta">
            {st.status === "processing" &&
              (progress ? `Lecture IA — page ${progress.done}/${progress.total}…` : "Envoi et lecture par l'IA…")}
            {st.status === "empty" && (
              <span style={{ color: "var(--amber)" }}>
                Aucune opération détectée (ce fichier n&apos;est peut-être pas un relevé bancaire).
              </span>
            )}
            {st.status === "error" && <span style={{ color: "var(--red)" }}>{st.error}</span>}
            {showParts && (
              <>
                <strong>{parts.length}</strong> compte(s) détecté(s) · <strong>{st.nbRows ?? 0}</strong> opération(s)
              </>
            )}
          </div>
        </div>

        {st.status === "error" && (
          <button className="icon-btn" onClick={onRetry} title="Réessayer">
            <RotateCw size={15} />
          </button>
        )}
        {st.status !== "processing" && (
          <button className="filecard-remove" onClick={onRemove} title="Supprimer">
            <Trash2 size={15} />
          </button>
        )}
      </div>

      {showParts && (
        <div className="stmt-parts">
          {parts.map((part) => {
            const ck = `${st.id}::${part.key}`;
            const creating = creatingFor === ck;
            const det = part.detected;
            const canCreate = !!(det && (det.banque || det.iban));
            const resolvedAcc = accounts.find((a) => a.id === part.resolvedAccountId);
            return (
              <div key={part.key} className="stmt-part">
                <div className="stmt-part-head">
                  <span className="stmt-part-icon"><Landmark size={15} /></span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="stmt-part-label">
                      {partLabel(det)}
                      {det?.usage && (
                        <span style={{ marginLeft: 8 }}><UsageBadge usage={det.usage} /></span>
                      )}
                    </div>
                    <div className="stmt-part-meta">
                      {part.imported ? (
                        <span style={{ color: "var(--green-dark)" }}>
                          <strong>{part.nbImported}</strong> importée(s)
                          {resolvedAcc ? ` → ${resolvedAcc.libelle}` : ""}
                        </span>
                      ) : (
                        <><strong>{part.nbRows}</strong> opération(s) — à rattacher</>
                      )}
                    </div>
                  </div>

                  {part.imported ? (
                    <CheckCircle2 size={18} style={{ color: "var(--green)", flexShrink: 0 }} />
                  ) : (
                    <div className="rl-select-wrap">
                      <select
                        className="rl-select"
                        value={creating ? CREATE : ""}
                        onChange={(e) => onAssign(part, e.target.value)}
                      >
                        <option value="">Rattacher à un compte…</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>{accLabel(a)}</option>
                        ))}
                        {canCreate && (
                          <option value={CREATE}>
                            ＋ Créer « {det?.banque || "compte"}{det?.iban ? ` …${iban4(det.iban)}` : ""} »
                          </option>
                        )}
                      </select>
                    </div>
                  )}
                </div>

                {creating && (
                  <div className="filecard-create">
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      Nouveau compte « {det?.banque || "Banque"}{det?.iban ? ` …${iban4(det.iban)}` : ""} » →
                    </span>
                    <div className="rl-select-wrap">
                      <select className="rl-select" value={newEntityId} onChange={(e) => onSetNewEntity(e.target.value)}>
                        <option value="">Entité de rattachement…</option>
                        {entities.map((en) => (
                          <option key={en.id} value={en.id}>{en.denomination}</option>
                        ))}
                      </select>
                    </div>
                    <button className="btn secondary" disabled={!newEntityId} onClick={() => onCreateAccount(part)}>
                      <Plus />
                      Créer et importer
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
