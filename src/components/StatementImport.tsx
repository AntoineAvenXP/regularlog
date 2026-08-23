"use client";

import { useState, useRef } from "react";
import {
  UploadCloud,
  FileText,
  Image as ImageIcon,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Trash2,
  Sparkles,
  RotateCw,
  Briefcase,
  User,
  Landmark,
} from "lucide-react";
import { SectionHeader } from "@/components/PageHeader";
import ConfirmModal from "@/components/ConfirmModal";
import { isPdf } from "@/lib/storage";
import { useStatements } from "@/lib/statementsEngine";
import type { BankAccount, Statement, StatementPart, Usage } from "@/lib/types";

const iban4 = (iban?: string | null): string | null => {
  if (!iban) return null;
  const digits = iban.replace(/\s/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
};

/**
 * Afficheur de l'import de relevés. La logique (file, traitement, progression,
 * multi-comptes, auto-rattachement, catégorisation) vit dans StatementsProvider
 * (monté dans le layout) → elle survit à la navigation.
 */
export default function StatementImport() {
  const { statements, progress, accounts, addFiles, setPartUsage, retry, remove } =
    useStatements();

  const [drag, setDrag] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
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

  const working = statements.some((s) => s.status === "processing");
  const delCount = toDelete
    ? (toDelete.parts ?? []).reduce((s, p) => s + (p.nbImported ?? 0), 0)
    : 0;

  const accLabel = (a: BankAccount) => a.libelle;

  return (
    <section className="card">
      <SectionHeader icon={Sparkles} title="Relevés bancaires (lecture IA)" />
      <p className="muted" style={{ marginTop: 0, marginBottom: 16, fontSize: 12.5 }}>
        Dépose tes relevés (PDF ou images). L&apos;IA détecte le(s) compte(s), classe
        les opérations et les fait remonter automatiquement dans{" "}
        <strong>Transactions</strong> — sans rien à rattacher. La lecture continue
        même si tu changes de page.
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

      {statements.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          {statements.map((st) => (
            <StatementRow
              key={st.id}
              st={st}
              progress={progress[st.id]}
              accounts={accounts}
              accLabel={accLabel}
              onToggleUsage={(part) =>
                setPartUsage(st, part.key, part.detected?.usage === "pro" ? "perso" : "pro")
              }
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

/** Pilule Pro/Perso cliquable : un clic bascule pro ↔ perso. */
function UsageToggle({ usage, onClick }: { usage: Usage; onClick: () => void }) {
  const pro = usage === "pro";
  return (
    <button
      type="button"
      className="usage-pill"
      data-usage={usage}
      onClick={onClick}
      title="Cliquer pour basculer pro / perso"
    >
      {pro ? <Briefcase size={11} /> : <User size={11} />}
      {pro ? "Pro" : "Perso"}
    </button>
  );
}

function statusIcon(s: Statement["status"]) {
  if (s === "processing") return <Loader2 size={18} className="spin" style={{ color: "var(--green)" }} />;
  if (s === "imported") return <CheckCircle2 size={18} style={{ color: "var(--green)" }} />;
  if (s === "ready") return <Loader2 size={18} className="spin" style={{ color: "var(--green)" }} />;
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
  accLabel,
  onToggleUsage,
  onRetry,
  onRemove,
}: {
  st: Statement;
  progress?: { done: number; total: number };
  accounts: BankAccount[];
  accLabel: (a: BankAccount) => string;
  onToggleUsage: (part: StatementPart) => void;
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
            {st.status === "ready" && "Import en cours…"}
            {st.status === "empty" && (
              <span style={{ color: "var(--amber)" }}>
                Aucune opération détectée (ce fichier n&apos;est peut-être pas un relevé bancaire).
              </span>
            )}
            {st.status === "error" && <span style={{ color: "var(--red)" }}>{st.error}</span>}
            {st.status === "imported" && (
              <>
                <strong>{parts.length}</strong> compte(s) · <strong>{st.nbRows ?? 0}</strong> opération(s) importée(s)
              </>
            )}
          </div>
        </div>

        {st.status === "error" && (
          <button className="icon-btn" onClick={onRetry} title="Réessayer">
            <RotateCw size={15} />
          </button>
        )}
        {st.status !== "processing" && st.status !== "ready" && (
          <button className="filecard-remove" onClick={onRemove} title="Supprimer">
            <Trash2 size={15} />
          </button>
        )}
      </div>

      {showParts && (
        <div className="stmt-parts">
          {parts.map((part) => {
            const det = part.detected;
            const resolvedAcc = accounts.find((a) => a.id === part.resolvedAccountId);
            return (
              <div key={part.key} className="stmt-part">
                <div className="stmt-part-head">
                  <span className="stmt-part-icon"><Landmark size={15} /></span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="stmt-part-label">{partLabel(det)}</div>
                    <div className="stmt-part-meta">
                      {part.imported ? (
                        <span style={{ color: "var(--green-dark)" }}>
                          <strong>{part.nbImported}</strong> importée(s)
                          {resolvedAcc ? ` → ${accLabel(resolvedAcc)}` : ""}
                        </span>
                      ) : (
                        <><strong>{part.nbRows}</strong> opération(s)…</>
                      )}
                    </div>
                  </div>
                  {det && <UsageToggle usage={det.usage ?? "perso"} onClick={() => onToggleUsage(part)} />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
