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
import { isPdf } from "@/lib/storage";
import { useStatements } from "@/lib/statementsEngine";
import type { BankAccount, Entity, Statement, Usage } from "@/lib/types";

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
 * Afficheur de l'import de relevés. Toute la logique (file, traitement,
 * progression) vit dans StatementsProvider (monté dans le layout) → elle
 * survit à la navigation. Ce composant lit et pilote ce moteur.
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
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [newEntityId, setNewEntityId] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFiles(files: FileList | File[]) {
    const rej = await addFiles(files);
    setRejected(rej);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files?.length) void onFiles(e.dataTransfer.files);
  }

  async function onAssign(st: Statement, value: string) {
    if (value === CREATE) {
      setCreatingFor(st.id);
      return;
    }
    setCreatingFor((c) => (c === st.id ? null : c));
    if (value) await assignAccount(st, value);
  }

  async function onCreate(st: Statement) {
    if (!newEntityId) return;
    await createAccountFor(st, newEntityId);
    setCreatingFor(null);
    setNewEntityId("");
  }

  async function onRemove(st: Statement) {
    const n = st.nbImported ?? 0;
    const msg =
      st.status === "imported" && n > 0
        ? `Supprimer « ${st.fileName} » et ses ${n} transaction(s) importée(s) ?\n\nLes transactions correspondantes seront retirées de Regularlog. Cette action est irréversible.`
        : `Retirer « ${st.fileName} » de la liste ?`;
    if (window.confirm(msg)) await remove(st);
  }

  const working = statements.some((s) => s.status === "processing");

  const detectedAccounts = useMemo(() => {
    const map = new Map<string, { banque: string | null; iban4: string | null; usage: Usage | null; matched: boolean }>();
    for (const s of statements) {
      if (!s.detected) continue;
      const key = `${norm(s.detected.banque || "")}|${iban4(s.detected.iban) || ""}`;
      const cur = map.get(key) ?? {
        banque: s.detected.banque,
        iban4: iban4(s.detected.iban),
        usage: s.detected.usage,
        matched: !!s.resolvedAccountId,
      };
      if (s.resolvedAccountId) cur.matched = true;
      map.set(key, cur);
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
        Dépose tes relevés (PDF ou images). Ils sont conservés et lus par l&apos;IA :
        le compte est détecté (banque, IBAN, pro/perso) et les opérations remontent
        automatiquement dans <strong>Transactions</strong> dès qu&apos;un compte est
        rattaché. La lecture continue même si tu changes de page.
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
              creating={creatingFor === st.id}
              newEntityId={newEntityId}
              onAssign={(v) => onAssign(st, v)}
              onSetNewEntity={setNewEntityId}
              onCreateAccount={() => onCreate(st)}
              onRetry={() => retry(st)}
              onRemove={() => onRemove(st)}
            />
          ))}
        </div>
      )}
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

function StatementRow({
  st,
  progress,
  accounts,
  entities,
  accLabel,
  creating,
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
  creating: boolean;
  newEntityId: string;
  onAssign: (v: string) => void;
  onSetNewEntity: (v: string) => void;
  onCreateAccount: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const pdf = isPdf(st.fileName);
  const det = st.detected;
  const detLabel = det
    ? [det.banque, det.iban ? `…${iban4(det.iban)}` : null, det.periode].filter(Boolean).join(" · ") || "compte non détecté"
    : "compte non détecté";
  const canCreate = !!(det && (det.banque || det.iban));
  const resolvedAcc = accounts.find((a) => a.id === st.resolvedAccountId);

  return (
    <div className="filecard">
      <div className="filecard-head">
        <span className="filecard-status">{statusIcon(st.status)}</span>
        <span className="filecard-type">{pdf ? <FileText size={16} /> : <ImageIcon size={16} />}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="filecard-name" title={st.fileName}>
            {st.fileName}
            {det?.usage && (
              <span style={{ marginLeft: 8 }}>
                <UsageBadge usage={det.usage} />
              </span>
            )}
          </div>
          <div className="filecard-meta">
            {st.status === "processing" &&
              (progress
                ? `Lecture IA — page ${progress.done}/${progress.total}…`
                : "Envoi et lecture par l'IA…")}
            {st.status === "empty" && (
              <span style={{ color: "var(--amber)" }}>
                Aucune opération détectée (ce fichier n&apos;est peut-être pas un relevé bancaire).
              </span>
            )}
            {st.status === "error" && <span style={{ color: "var(--red)" }}>{st.error}</span>}
            {st.status === "ready" && (
              <>
                {detLabel} · <strong>{st.nbRows}</strong> opération(s) — rattache un compte pour importer
              </>
            )}
            {st.status === "imported" && (
              <>
                {detLabel} · <strong>{st.nbImported}</strong> importée(s)
                {resolvedAcc ? ` → ${resolvedAcc.libelle}` : ""}
              </>
            )}
          </div>
        </div>

        {st.status === "ready" && (
          <div className="filecard-account">
            <select value={creating ? CREATE : ""} onChange={(e) => onAssign(e.target.value)}>
              <option value="">— rattacher à un compte —</option>
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

      {creating && (
        <div className="filecard-create">
          <span className="muted" style={{ fontSize: 12.5 }}>
            Nouveau compte « {det?.banque || "Banque"}{det?.iban ? ` …${iban4(det.iban)}` : ""} » →
          </span>
          <select value={newEntityId} onChange={(e) => onSetNewEntity(e.target.value)}>
            <option value="">— entité de rattachement —</option>
            {entities.map((en) => (
              <option key={en.id} value={en.id}>{en.denomination}</option>
            ))}
          </select>
          <button className="btn secondary" disabled={!newEntityId} onClick={onCreateAccount}>
            <Plus />
            Créer et importer
          </button>
        </div>
      )}
    </div>
  );
}
