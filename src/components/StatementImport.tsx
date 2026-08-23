"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { COL, createOwned, deleteOwned, listOwned, updateOwned } from "@/lib/db";
import { extractStatementAI } from "@/lib/aiExtract";
import { fingerprint, parseDate } from "@/lib/parsing";
import { hashFile, weakKey, writeImport, type TxDraft } from "@/lib/importWrite";
import {
  deleteFile,
  getFileBytes,
  isPdf,
  statementPath,
  uploadFile,
} from "@/lib/storage";
import type {
  BankAccount,
  Entity,
  Statement,
  Transaction,
  Usage,
} from "@/lib/types";

const MAX_FILES = 100;
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

function mimeOf(name: string): string {
  if (isPdf(name)) return "application/pdf";
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "application/octet-stream";
}

/**
 * Import de relevés par l'IA — PERSISTANT et PROGRESSIF.
 * Chaque fichier déposé est conservé dans Storage + suivi dans Firestore
 * (collection statements) : il survit à la navigation. L'IA lit le relevé,
 * détecte le compte (banque/IBAN/titulaire + pro/perso) et les opérations,
 * qui sont importées au fil de l'eau dès que le compte est rattaché.
 */
export default function StatementImport({
  entities,
  accounts,
  existingFileHashes,
  onImported,
  onAccountsChanged,
}: {
  entities: Entity[];
  accounts: BankAccount[];
  existingFileHashes: Set<string>;
  onImported: (n: number) => void;
  onAccountsChanged: (newAccountId?: string) => void;
}) {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [drag, setDrag] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [newEntityId, setNewEntityId] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const accountsRef = useRef<BankAccount[]>(accounts);
  accountsRef.current = accounts;

  const patch = useCallback(
    (id: string, p: Partial<Statement>) =>
      setStatements((prev) => prev.map((s) => (s.id === id ? { ...s, ...p } : s))),
    []
  );

  const load = useCallback(async () => {
    const list = await listOwned<Statement>(COL.statements);
    list.sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
    setStatements(list);
    return list;
  }, []);

  // ---- Rattachement automatique d'un compte détecté à un compte existant.
  const autoMatch = useCallback((det: Statement["detected"]): string => {
    if (!det) return "";
    const acc = accountsRef.current;
    const four = iban4(det.iban);
    if (four) {
      const byIban = acc.find((a) => iban4(a.ibanPartiel) === four);
      if (byIban) return byIban.id;
    }
    if (det.banque) {
      const nb = norm(det.banque);
      if (nb) {
        const byBank = acc.find((a) => {
          const na = norm(a.banque);
          return na && (na === nb || na.includes(nb) || nb.includes(na));
        });
        if (byBank) return byBank.id;
      }
    }
    return "";
  }, []);

  // ---- Dédup fraîche + transactions Bridge à écraser, pour un compte donné.
  async function buildDedup(accountId: string) {
    const all = await listOwned<Transaction>(COL.transactions);
    const existing = new Set<string>();
    const bridgeWeak = new Map<string, string>();
    for (const t of all) {
      if (t.bankAccountId !== accountId) continue;
      if (t.origine === "bridge") bridgeWeak.set(weakKey(t.dateOperation, t.montant), t.id);
      else existing.add(t.fingerprint);
    }
    return { existing, bridgeWeak };
  }

  /** Écrit les transactions d'un relevé sur un compte (dédup + Bridge écrasé). */
  const importResolved = useCallback(
    async (st: Statement, accountId: string) => {
      const acc = accountsRef.current.find((a) => a.id === accountId);
      if (!acc || !st.rows) return;
      const { existing, bridgeWeak } = await buildDedup(accountId);
      const seen = new Set<string>();
      const drafts: TxDraft[] = [];
      const supersede = new Set<string>();
      for (const r of st.rows) {
        const d = parseDate(r.date);
        const m = r.montant;
        if (!d || m == null || !r.libelle?.trim()) continue;
        const fp = fingerprint(accountId, d, m, r.libelle.trim());
        if (existing.has(fp) || seen.has(fp)) continue;
        seen.add(fp);
        drafts.push({ dateOperation: d, dateValeur: null, libelle: r.libelle.trim(), montant: m, fp });
        const bId = bridgeWeak.get(weakKey(d, m));
        if (bId) supersede.add(bId);
      }
      const pdf = isPdf(st.fileName);
      const n = drafts.length
        ? await writeImport({
            account: acc,
            drafts,
            origine: pdf ? "import_pdf" : "import_ocr",
            aVerifier: true,
            importKind: pdf ? "pdf" : "ocr",
            fileName: st.fileName,
            file: null, // déjà conservé via le relevé
            fileHash: st.fileHash ?? null,
            supersedeTxIds: [...supersede],
            usage: st.detected?.usage ?? null,
          })
        : 0;
      await updateOwned(COL.statements, st.id, {
        status: "imported",
        resolvedAccountId: accountId,
        nbImported: n,
        rows: [],
      });
      patch(st.id, {
        status: "imported",
        resolvedAccountId: accountId,
        nbImported: n,
        rows: [],
      });
      onImported(n);
    },
    [onImported, patch]
  );

  // ---- Traitement IA d'un relevé (lecture + auto-import si compte résolu).
  const processStatement = useCallback(
    async (st: Statement, providedFile?: File) => {
      try {
        let file = providedFile;
        if (!file) {
          const bytes = await getFileBytes(st.storagePath);
          file = new File([bytes], st.fileName, { type: mimeOf(st.fileName) });
        }
        const { account, rows } = await extractStatementAI(file);
        const detected = account
          ? {
              banque: account.banque,
              iban: account.iban,
              titulaire: account.titulaire,
              periode: account.periode,
              usage: (account.usage ?? null) as Usage | null,
            }
          : null;
        const cleanRows = rows.map((r) => ({
          date: r.date ?? null,
          libelle: r.libelle,
          montant: r.montant,
        }));
        const nbRows = cleanRows.filter((r) => r.date && r.montant != null && r.libelle).length;

        if (nbRows === 0) {
          await updateOwned(COL.statements, st.id, { detected, rows: [], nbRows: 0, status: "empty" });
          patch(st.id, { detected, rows: [], nbRows: 0, status: "empty" });
          return;
        }

        const matched = autoMatch(detected);
        await updateOwned(COL.statements, st.id, {
          detected,
          rows: cleanRows,
          nbRows,
          resolvedAccountId: matched || null,
          status: matched ? "processing" : "ready",
        });
        const merged: Statement = {
          ...st,
          detected,
          rows: cleanRows,
          nbRows,
          resolvedAccountId: matched || null,
          status: matched ? "processing" : "ready",
        };
        patch(st.id, merged);

        if (matched) await importResolved(merged, matched);
      } catch (e) {
        const msg = (e as Error).message;
        await updateOwned(COL.statements, st.id, { status: "error", error: msg });
        patch(st.id, { status: "error", error: msg });
      }
    },
    [autoMatch, importResolved, patch]
  );

  // ---- File de traitement séquentielle (un relevé à la fois).
  const queueRef = useRef<{ id: string; file?: File }[]>([]);
  const runningRef = useRef(false);
  const [working, setWorking] = useState(false);

  const drain = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setWorking(true);
    try {
      while (queueRef.current.length) {
        const next = queueRef.current.shift()!;
        const st = (await listOwned<Statement>(COL.statements)).find((s) => s.id === next.id);
        // On relit le doc pour partir d'un état frais ; sinon on saute.
        if (st) await processStatement(st, next.file);
      }
    } finally {
      runningRef.current = false;
      setWorking(false);
    }
  }, [processStatement]);

  const enqueue = useCallback(
    (items: { id: string; file?: File }[]) => {
      queueRef.current.push(...items);
      void drain();
    },
    [drain]
  );

  // ---- Montage : charge la liste + reprend les traitements interrompus.
  useEffect(() => {
    (async () => {
      const list = await load();
      const toResume = list.filter((s) => s.status === "processing");
      if (toResume.length) enqueue(toResume.map((s) => ({ id: s.id })));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Dépôt de fichiers.
  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files).filter(
        (f) => isPdf(f.name) || f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)
      );
      if (arr.length === 0) return;
      const room = MAX_FILES - statements.length;
      const accepted = arr.slice(0, Math.max(0, room));

      const seenHashes = new Set<string>([
        ...existingFileHashes,
        ...(statements.map((s) => s.fileHash).filter(Boolean) as string[]),
      ]);
      const rej: string[] = [];
      const toProcess: { id: string; file: File }[] = [];

      for (const file of accepted) {
        let hash: string | undefined;
        try {
          hash = await hashFile(file);
        } catch {
          hash = undefined;
        }
        if (hash && seenHashes.has(hash)) {
          rej.push(file.name);
          continue;
        }
        if (hash) seenHashes.add(hash);
        const id = await createOwned(COL.statements, {
          fileName: file.name,
          fileHash: hash ?? null,
          storagePath: "",
          status: "processing" as const,
          detected: null,
          resolvedAccountId: null,
          rows: [],
          nbRows: 0,
          nbImported: 0,
        });
        const path = statementPath(id, file.name);
        await uploadFile(path, file);
        await updateOwned(COL.statements, id, { storagePath: path });
        const st: Statement = {
          id,
          ownerUid: "",
          fileName: file.name,
          fileHash: hash ?? null,
          storagePath: path,
          status: "processing",
          detected: null,
          resolvedAccountId: null,
          rows: [],
          nbRows: 0,
          nbImported: 0,
        };
        setStatements((prev) => [st, ...prev]);
        toProcess.push({ id, file });
      }
      setRejected(rej);
      if (toProcess.length) enqueue(toProcess);
    },
    [statements, existingFileHashes, enqueue]
  );

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
  }

  // ---- Rattachement manuel (état "ready") → import immédiat.
  async function assignAccount(st: Statement, value: string) {
    if (value === CREATE) {
      setCreatingFor(st.id);
      return;
    }
    setCreatingFor((c) => (c === st.id ? null : c));
    if (value) await importResolved(st, value);
  }

  async function createAccountFor(st: Statement) {
    if (!newEntityId || !st.detected) return;
    const det = st.detected;
    const id = await createOwned(COL.accounts, {
      entityId: newEntityId,
      banque: det.banque || "Banque",
      libelle: det.banque || det.titulaire || st.fileName,
      ibanPartiel: iban4(det.iban),
      source: "import" as const,
      bridgeAccountId: null,
    });
    setCreatingFor(null);
    setNewEntityId("");
    onAccountsChanged(id);
    accountsRef.current = [
      ...accountsRef.current,
      { id, ownerUid: "", entityId: newEntityId, banque: det.banque || "Banque", libelle: det.banque || st.fileName, ibanPartiel: iban4(det.iban), source: "import", bridgeAccountId: null },
    ];
    await importResolved({ ...st, detected: det }, id);
  }

  async function retry(st: Statement) {
    await updateOwned(COL.statements, st.id, { status: "processing", error: null });
    patch(st.id, { status: "processing", error: null });
    enqueue([{ id: st.id }]);
  }

  async function remove(st: Statement) {
    if (!window.confirm(`Retirer « ${st.fileName} » de la liste ? (les transactions déjà importées sont conservées)`)) return;
    if (st.storagePath) await deleteFile(st.storagePath);
    await deleteOwned(COL.statements, st.id);
    setStatements((prev) => prev.filter((s) => s.id !== st.id));
  }

  // ---- Récap des comptes bancaires détectés.
  const detectedAccounts = useMemo(() => {
    const map = new Map<string, { banque: string | null; iban4: string | null; usage: Usage | null; matched: boolean; count: number }>();
    for (const s of statements) {
      if (!s.detected) continue;
      const key = `${norm(s.detected.banque || "")}|${iban4(s.detected.iban) || ""}`;
      const cur = map.get(key) ?? {
        banque: s.detected.banque,
        iban4: iban4(s.detected.iban),
        usage: s.detected.usage,
        matched: !!s.resolvedAccountId,
        count: 0,
      };
      cur.count++;
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
        automatiquement dans <strong>Transactions</strong> dès qu&apos;un compte est rattaché.
      </p>

      {/* Zone de dépôt */}
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
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {rejected.length > 0 && (
        <p style={{ marginTop: 10, fontSize: 12.5, color: "var(--amber)" }}>
          {rejected.length} relevé(s) déjà importé(s), ignoré(s) : {rejected.join(", ")}
        </p>
      )}

      {/* Comptes bancaires détectés */}
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

      {/* Liste des relevés */}
      {statements.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          {statements.map((st) => (
            <StatementRow
              key={st.id}
              st={st}
              accounts={accounts}
              entities={entities}
              accLabel={accLabel}
              creating={creatingFor === st.id}
              newEntityId={newEntityId}
              onAssign={(v) => assignAccount(st, v)}
              onSetNewEntity={setNewEntityId}
              onCreateAccount={() => createAccountFor(st)}
              onRetry={() => retry(st)}
              onRemove={() => remove(st)}
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
            {st.status === "processing" && "Lecture par l'IA…"}
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
          <button className="filecard-remove" onClick={onRemove} title="Retirer">
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
