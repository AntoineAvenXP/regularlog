"use client";

// Moteur d'import des relevés — monté AU-DESSUS des pages (dans le layout) pour
// SURVIVRE à la navigation : la file de traitement, la progression et les
// fichiers en mémoire restent vivants même quand on change de page. La section
// « Relevés » de la page Imports n'est plus qu'un afficheur de ce moteur.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { writeBatch, doc } from "firebase/firestore";
import { db } from "./firebase";
import { COL, createOwned, deleteOwned, listOwned, updateOwned } from "./db";
import {
  buildStatementPdf,
  extractFromImages,
  toPageImages,
} from "./statementExtract";
import { fingerprint, parseDate } from "./parsing";
import { hashFile, weakKey, writeImport, type TxDraft } from "./importWrite";
import {
  deleteFile,
  getFileBytes,
  isPdf,
  statementPath,
  uploadBlob,
} from "./storage";
import type {
  BankAccount,
  Entity,
  Statement,
  Transaction,
  Usage,
} from "./types";
import { useAuth } from "./auth";

const MAX_FILES = 100;

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

export interface StatementsCtx {
  ready: boolean;
  statements: Statement[];
  progress: Record<string, { done: number; total: number }>;
  accounts: BankAccount[];
  entities: Entity[];
  addFiles: (files: FileList | File[]) => Promise<string[]>; // renvoie les rejetés
  assignAccount: (st: Statement, accountId: string) => Promise<void>;
  createAccountFor: (st: Statement, entityId: string) => Promise<void>;
  retry: (st: Statement) => Promise<void>;
  remove: (st: Statement) => Promise<void>;
}

const Ctx = createContext<StatementsCtx | null>(null);

export function StatementsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [ready, setReady] = useState(false);
  const [statements, setStatements] = useState<Statement[]>([]);
  const [progress, setProgress] = useState<Record<string, { done: number; total: number }>>({});
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);

  const statementsRef = useRef<Statement[]>([]);
  statementsRef.current = statements;
  const accountsRef = useRef<BankAccount[]>([]);
  accountsRef.current = accounts;
  const importHashesRef = useRef<Set<string>>(new Set());
  const filesRef = useRef<Map<string, File>>(new Map());

  const patch = useCallback(
    (id: string, p: Partial<Statement>) =>
      setStatements((prev) => prev.map((s) => (s.id === id ? { ...s, ...p } : s))),
    []
  );

  const loadStatements = useCallback(async () => {
    const list = await listOwned<Statement>(COL.statements);
    list.sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
    setStatements(list);
    return list;
  }, []);

  const loadAux = useCallback(async () => {
    const [acc, ent, imports] = await Promise.all([
      listOwned<BankAccount>(COL.accounts),
      listOwned<Entity>(COL.entities),
      listOwned<{ id: string; fileHash?: string | null }>(COL.imports),
    ]);
    setAccounts(acc);
    setEntities(ent);
    importHashesRef.current = new Set(
      imports.map((i) => i.fileHash).filter(Boolean) as string[]
    );
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
      const res = drafts.length
        ? await writeImport({
            account: acc,
            drafts,
            origine: pdf ? "import_pdf" : "import_ocr",
            aVerifier: true,
            importKind: pdf ? "pdf" : "ocr",
            fileName: st.fileName,
            file: null,
            fileHash: st.fileHash ?? null,
            supersedeTxIds: [...supersede],
            usage: st.detected?.usage ?? null,
          })
        : null;
      const update = {
        status: "imported" as const,
        resolvedAccountId: accountId,
        nbImported: res?.count ?? 0,
        importId: res?.importId ?? null,
        rows: [],
      };
      await updateOwned(COL.statements, st.id, update);
      patch(st.id, update);
      if (res?.importId) importHashesRef.current.add(st.fileHash ?? "");
    },
    [patch]
  );

  const processStatement = useCallback(
    async (st: Statement) => {
      try {
        let file = filesRef.current.get(st.id);
        if (!file) {
          if (!st.storagePath) throw new Error("Fichier non disponible. Re-dépose le relevé.");
          const bytes = await getFileBytes(st.storagePath);
          file = new File([bytes], st.fileName, { type: mimeOf(st.fileName) });
        }
        const pages = await toPageImages(file);

        // Copie PDF légère persistée (best-effort) — le traitement continue même
        // si l'upload échoue.
        if (!st.storagePath && pages.length) {
          try {
            const blob = await buildStatementPdf(pages);
            const pdfName = st.fileName.replace(/\.[^.]+$/, "") + ".pdf";
            const path = statementPath(st.id, pdfName);
            await uploadBlob(path, blob, "application/pdf");
            await updateOwned(COL.statements, st.id, { storagePath: path });
            patch(st.id, { storagePath: path });
          } catch {
            /* persistance non bloquante */
          }
        }

        const { account, rows } = await extractFromImages(pages, (done, total) =>
          setProgress((p) => ({ ...p, [st.id]: { done, total } }))
        );
        setProgress((p) => {
          const n = { ...p };
          delete n[st.id];
          return n;
        });

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
        const base = {
          detected,
          rows: cleanRows,
          nbRows,
          resolvedAccountId: matched || null,
          status: matched ? ("processing" as const) : ("ready" as const),
        };
        await updateOwned(COL.statements, st.id, base);
        const merged: Statement = { ...st, ...base };
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

  // ---- File de traitement séquentielle (persiste à la navigation).
  const queueRef = useRef<string[]>([]);
  const runningRef = useRef(false);

  const drain = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      while (queueRef.current.length) {
        const id = queueRef.current.shift()!;
        const st = (await listOwned<Statement>(COL.statements)).find((s) => s.id === id);
        if (st) await processStatement(st);
      }
    } finally {
      runningRef.current = false;
    }
  }, [processStatement]);

  const enqueue = useCallback(
    (ids: string[]) => {
      queueRef.current.push(...ids);
      void drain();
    },
    [drain]
  );

  // ---- Chargement initial + reprise (une seule fois par session authentifiée).
  useEffect(() => {
    if (!user) {
      setStatements([]);
      setProgress({});
      setReady(false);
      return;
    }
    let cancelled = false;
    (async () => {
      await loadAux();
      const list = await loadStatements();
      if (cancelled) return;
      setReady(true);
      const stuck = list.filter((s) => s.status === "processing");
      if (stuck.length) enqueue(stuck.map((s) => s.id));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const addFiles = useCallback(
    async (files: FileList | File[]): Promise<string[]> => {
      const arr = Array.from(files).filter(
        (f) => isPdf(f.name) || f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)
      );
      if (arr.length === 0) return [];
      const room = MAX_FILES - statementsRef.current.length;
      const accepted = arr.slice(0, Math.max(0, room));

      const seenHashes = new Set<string>([
        ...importHashesRef.current,
        ...(statementsRef.current.map((s) => s.fileHash).filter(Boolean) as string[]),
      ]);
      const rejected: string[] = [];
      const toProcess: string[] = [];

      for (const file of accepted) {
        let hash: string | undefined;
        try {
          hash = await hashFile(file);
        } catch {
          hash = undefined;
        }
        if (hash && seenHashes.has(hash)) {
          rejected.push(file.name);
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
          importId: null,
          rows: [],
          nbRows: 0,
          nbImported: 0,
        });
        const st: Statement = {
          id,
          ownerUid: "",
          fileName: file.name,
          fileHash: hash ?? null,
          storagePath: "",
          status: "processing",
          detected: null,
          resolvedAccountId: null,
          importId: null,
          rows: [],
          nbRows: 0,
          nbImported: 0,
        };
        setStatements((prev) => [st, ...prev]);
        filesRef.current.set(id, file);
        toProcess.push(id);
      }
      if (toProcess.length) enqueue(toProcess);
      return rejected;
    },
    [enqueue]
  );

  const assignAccount = useCallback(
    async (st: Statement, accountId: string) => {
      if (accountId) await importResolved(st, accountId);
    },
    [importResolved]
  );

  const createAccountFor = useCallback(
    async (st: Statement, entityId: string) => {
      if (!entityId || !st.detected) return;
      const det = st.detected;
      const id = await createOwned(COL.accounts, {
        entityId,
        banque: det.banque || "Banque",
        libelle: det.banque || det.titulaire || st.fileName,
        ibanPartiel: iban4(det.iban),
        source: "import" as const,
        bridgeAccountId: null,
      });
      const newAcc: BankAccount = {
        id,
        ownerUid: "",
        entityId,
        banque: det.banque || "Banque",
        libelle: det.banque || st.fileName,
        ibanPartiel: iban4(det.iban),
        source: "import",
        bridgeAccountId: null,
      };
      accountsRef.current = [...accountsRef.current, newAcc];
      setAccounts((prev) => [...prev, newAcc]);
      await importResolved({ ...st, detected: det }, id);
    },
    [importResolved]
  );

  const retry = useCallback(
    async (st: Statement) => {
      if (!st.storagePath && !filesRef.current.has(st.id)) {
        const msg = "Fichier non disponible (page rechargée). Re-dépose le relevé.";
        await updateOwned(COL.statements, st.id, { status: "error", error: msg });
        patch(st.id, { status: "error", error: msg });
        return;
      }
      await updateOwned(COL.statements, st.id, { status: "processing", error: null });
      patch(st.id, { status: "processing", error: null });
      enqueue([st.id]);
    },
    [enqueue, patch]
  );

  /** Supprime un relevé ET, en cascade, toutes les transactions de son import. */
  const remove = useCallback(async (st: Statement) => {
    if (st.importId) {
      const all = await listOwned<Transaction>(COL.transactions);
      const toDel = all.filter((t) => t.importId === st.importId);
      for (let i = 0; i < toDel.length; i += 400) {
        const b = writeBatch(db);
        for (const t of toDel.slice(i, i + 400)) b.delete(doc(db, COL.transactions, t.id));
        await b.commit();
      }
      try {
        await deleteOwned(COL.imports, st.importId);
      } catch {
        /* lot déjà supprimé */
      }
    }
    if (st.storagePath) await deleteFile(st.storagePath);
    await deleteOwned(COL.statements, st.id);
    filesRef.current.delete(st.id);
    setStatements((prev) => prev.filter((s) => s.id !== st.id));
  }, []);

  const value: StatementsCtx = {
    ready,
    statements,
    progress,
    accounts,
    entities,
    addFiles,
    assignAccount,
    createAccountFor,
    retry,
    remove,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStatements(): StatementsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStatements doit être utilisé dans StatementsProvider");
  return ctx;
}
