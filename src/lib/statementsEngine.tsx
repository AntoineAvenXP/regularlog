"use client";

// Moteur d'import des relevés — monté AU-DESSUS des pages (dans le layout) pour
// SURVIVRE à la navigation. Gère le MULTI-COMPTES : un fichier peut contenir
// plusieurs comptes (numéros différents) ; chaque compte détecté est rattaché et
// importé séparément.

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
import { DEFAULT_CATEGORIES } from "./categories";
import { detectInternalFlowPairs } from "./internalFlows";
import {
  deleteFile,
  getFileBytes,
  isPdf,
  statementPath,
  uploadBlob,
} from "./storage";
import type {
  BankAccount,
  Category,
  Entity,
  Statement,
  StatementPart,
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

const partKeyOf = (iban?: string | null): string | null => {
  if (!iban) return null;
  const d = iban.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return d.length >= 4 ? d : null;
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

/** Ramène les relevés « hérités » (mono-compte) au format multi-comptes. */
function normalizeStatement(s: Statement): Statement {
  if (s.parts && s.parts.length) return s;
  if (s.detected || s.rows || s.importId || s.resolvedAccountId) {
    const part: StatementPart = {
      key: partKeyOf(s.detected?.iban) ?? "legacy",
      detected: s.detected ?? null,
      rows: s.rows ?? [],
      nbRows: s.nbRows ?? (s.rows?.length ?? 0),
      resolvedAccountId: s.resolvedAccountId ?? null,
      importId: s.importId ?? null,
      nbImported: s.nbImported ?? 0,
      imported: s.status === "imported",
    };
    return { ...s, parts: [part] };
  }
  return { ...s, parts: s.parts ?? [] };
}

function statusFromParts(parts: StatementPart[]): Statement["status"] {
  if (parts.length === 0) return "empty";
  return parts.every((p) => p.imported) ? "imported" : "ready";
}

export interface StatementsCtx {
  ready: boolean;
  statements: Statement[];
  progress: Record<string, { done: number; total: number }>;
  accounts: BankAccount[];
  entities: Entity[];
  addFiles: (files: FileList | File[]) => Promise<string[]>;
  setPartUsage: (st: Statement, partKey: string, usage: Usage) => Promise<void>;
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
  const entitiesRef = useRef<Entity[]>([]);
  entitiesRef.current = entities;
  const categoriesRef = useRef<string[]>([]);
  const importHashesRef = useRef<Set<string>>(new Set());
  const filesRef = useRef<Map<string, File>>(new Map());

  const patch = useCallback(
    (id: string, p: Partial<Statement>) =>
      setStatements((prev) => prev.map((s) => (s.id === id ? { ...s, ...p } : s))),
    []
  );

  const loadStatements = useCallback(async () => {
    const list = (await listOwned<Statement>(COL.statements)).map(normalizeStatement);
    list.sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
    setStatements(list);
    return list;
  }, []);

  const loadAux = useCallback(async () => {
    const [acc, ent, imports, cats] = await Promise.all([
      listOwned<BankAccount>(COL.accounts),
      listOwned<Entity>(COL.entities),
      listOwned<{ id: string; fileHash?: string | null }>(COL.imports),
      listOwned<Category>(COL.categories),
    ]);
    setAccounts(acc);
    setEntities(ent);
    importHashesRef.current = new Set(imports.map((i) => i.fileHash).filter(Boolean) as string[]);
    // Liste passée à l'IA pour catégoriser : celle de l'utilisateur, sinon défaut.
    const names = cats.map((c) => c.nom).filter(Boolean);
    categoriesRef.current = names.length ? names : DEFAULT_CATEGORIES;
  }, []);

  const autoMatch = useCallback((det: StatementPart["detected"]): string => {
    if (!det) return "";
    const acc = accountsRef.current;
    const four = iban4(det.iban);
    // Si un IBAN est détecté, on rattache UNIQUEMENT par IBAN : deux comptes de la
    // même banque (IBAN différents) ne doivent JAMAIS être fusionnés.
    if (four) {
      const byIban = acc.find((a) => iban4(a.ibanPartiel) === four);
      return byIban ? byIban.id : "";
    }
    // Pas d'IBAN détecté → repli prudent par nom de banque.
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

  /** Entité de rattachement d'un compte détecté (créée au besoin, sans friction). */
  async function getOrCreateEntity(det: StatementPart["detected"]): Promise<string> {
    const usage = det?.usage ?? "perso";
    const name = det?.titulaire?.trim() || (usage === "pro" ? "Professionnel" : "Personnel");
    const type = usage === "pro" ? "societe" : "personnel";
    const found = entitiesRef.current.find(
      (e) => e.denomination.toLowerCase() === name.toLowerCase()
    );
    if (found) return found.id;
    const id = await createOwned(COL.entities, { denomination: name, type, siren: null });
    const ent: Entity = { id, ownerUid: "", denomination: name, type, siren: null };
    entitiesRef.current = [...entitiesRef.current, ent];
    setEntities((prev) => [...prev, ent]);
    return id;
  }

  /** Compte Regularlog pour un compte détecté : rattaché s'il existe, sinon créé. */
  async function resolveOrCreateAccount(det: StatementPart["detected"]): Promise<string> {
    const matched = autoMatch(det);
    if (matched) return matched;
    const entityId = await getOrCreateEntity(det);
    const usage: Usage = det?.usage ?? "perso";
    const id = await createOwned(COL.accounts, {
      entityId,
      banque: det?.banque || "Banque",
      libelle: det?.banque || det?.titulaire || "Compte importé",
      ibanPartiel: iban4(det?.iban),
      source: "import" as const,
      bridgeAccountId: null,
      usage,
    });
    const acc: BankAccount = {
      id,
      ownerUid: "",
      entityId,
      banque: det?.banque || "Banque",
      libelle: det?.banque || det?.titulaire || "Compte importé",
      ibanPartiel: iban4(det?.iban),
      source: "import",
      bridgeAccountId: null,
      usage,
    };
    accountsRef.current = [...accountsRef.current, acc];
    setAccounts((prev) => [...prev, acc]);
    return id;
  }

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

  /** Écrit les opérations d'un compte détecté (part) vers un compte Regularlog. */
  const importPart = useCallback(
    async (st: Statement, partKey: string, accountId: string): Promise<Statement> => {
      const part = (st.parts ?? []).find((p) => p.key === partKey);
      const acc = accountsRef.current.find((a) => a.id === accountId);
      if (!part || !acc || !part.rows) return st;

      const { existing, bridgeWeak } = await buildDedup(accountId);
      const seen = new Set<string>();
      const drafts: TxDraft[] = [];
      const supersede = new Set<string>();
      for (const r of part.rows) {
        const d = parseDate(r.date);
        const m = r.montant;
        if (!d || m == null || !r.libelle?.trim()) continue;
        const fp = fingerprint(accountId, d, m, r.libelle.trim());
        if (existing.has(fp) || seen.has(fp)) continue;
        seen.add(fp);
        drafts.push({
          dateOperation: d,
          dateValeur: null,
          libelle: r.libelle.trim(),
          montant: m,
          fp,
          categorie: r.categorie ?? null,
          affectation: r.affectation ?? null,
          code: r.code ?? null,
        });
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
            // Le Pro/Perso est porté par le COMPTE, pas par la transaction.
          })
        : { importId: "", count: 0 };

      const parts = (st.parts ?? []).map((p) =>
        p.key === partKey
          ? {
              ...p,
              resolvedAccountId: accountId,
              importId: res.importId || null,
              nbImported: res.count,
              imported: true,
              rows: [],
            }
          : p
      );
      const upd = { parts, status: statusFromParts(parts) };
      await updateOwned(COL.statements, st.id, upd);
      patch(st.id, upd);
      if (res.importId && st.fileHash) importHashesRef.current.add(st.fileHash);
      return { ...st, ...upd };
    },
    [patch]
  );

  /**
   * Détection AUTOMATIQUE des flux internes : après un import, on cherche dans
   * TOUTES les transactions les virements miroirs (montant opposé, comptes
   * distincts, dates proches) et on les lie — typiquement une opération d'un
   * premier relevé qui réapparaît (à l'inverse) dans un second relevé.
   */
  const detectAndLinkFlows = useCallback(async () => {
    const all = await listOwned<Transaction>(COL.transactions);
    const pairs = detectInternalFlowPairs(all);
    if (!pairs.length) return;
    for (let i = 0; i < pairs.length; i += 200) {
      const chunk = pairs.slice(i, i + 200);
      const batch = writeBatch(db);
      for (const p of chunk) {
        batch.update(doc(db, COL.transactions, p.pos.id), {
          fluxInterne: true,
          transactionMiroirId: p.neg.id,
        });
        batch.update(doc(db, COL.transactions, p.neg.id), {
          fluxInterne: true,
          transactionMiroirId: p.pos.id,
        });
      }
      await batch.commit();
    }
  }, []);

  /** Importe tous les comptes non encore importés (rattache/crée les comptes). */
  const importAllParts = useCallback(
    async (st: Statement): Promise<Statement> => {
      let cur = st;
      for (const p of st.parts ?? []) {
        if (p.imported) continue;
        const accountId = await resolveOrCreateAccount(p.detected);
        cur = await importPart(cur, p.key, accountId);
      }
      return cur;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [importPart]
  );

  const processStatement = useCallback(
    async (st: Statement) => {
      try {
        let file = filesRef.current.get(st.id);
        if (!file) {
          // Reprise sans fichier en mémoire : on tente Storage (échec RAPIDE si
          // indisponible) avec un message clair plutôt qu'une erreur brute.
          if (!st.storagePath) throw new Error("Fichier non disponible. Re-dépose le relevé.");
          try {
            const bytes = await getFileBytes(st.storagePath);
            file = new File([bytes], st.fileName, { type: mimeOf(st.fileName) });
          } catch {
            throw new Error("Fichier non disponible (stockage). Re-dépose le relevé.");
          }
        }
        const pages = await toPageImages(file);

        // Persistance du fichier léger : EN ARRIÈRE-PLAN, jamais bloquante. Si
        // Storage est indisponible, l'IA + l'import continuent quand même.
        if (!st.storagePath && pages.length) {
          void (async () => {
            try {
              const blob = await buildStatementPdf(pages);
              const pdfName = st.fileName.replace(/\.[^.]+$/, "") + ".pdf";
              const path = statementPath(st.id, pdfName);
              await uploadBlob(path, blob, "application/pdf");
              await updateOwned(COL.statements, st.id, { storagePath: path });
              patch(st.id, { storagePath: path });
            } catch {
              /* stockage indisponible : copie non conservée, sans impact */
            }
          })();
        }

        const { groups } = await extractFromImages(pages, categoriesRef.current, (done, total) =>
          setProgress((p) => ({ ...p, [st.id]: { done, total } }))
        );
        setProgress((p) => {
          const n = { ...p };
          delete n[st.id];
          return n;
        });

        const seenKeys = new Set<string>();
        const parts: StatementPart[] = [];
        groups.forEach((g, i) => {
          const cleanRows = g.rows.map((r) => ({
            date: r.date ?? null,
            libelle: r.libelle,
            montant: r.montant,
            categorie: r.categorie ?? null,
            affectation: r.affectation ?? null,
            code: r.code ?? null,
          }));
          const nbRows = cleanRows.filter((r) => r.date && r.montant != null && r.libelle).length;
          if (nbRows === 0) return;
          let key = partKeyOf(g.account?.iban) ?? `part${i}`;
          while (seenKeys.has(key)) key = `${key}_${i}`;
          seenKeys.add(key);
          parts.push({
            key,
            // usage toujours renseigné (défaut « perso ») → toggle + tag transaction.
            detected: {
              banque: g.account?.banque ?? null,
              iban: g.account?.iban ?? null,
              titulaire: g.account?.titulaire ?? null,
              periode: g.account?.periode ?? null,
              usage: (g.account?.usage ?? "perso") as Usage,
            },
            rows: cleanRows,
            nbRows,
            resolvedAccountId: null,
            importId: null,
            nbImported: 0,
            imported: false,
          });
        });

        const totalRows = parts.reduce((s, p) => s + p.nbRows, 0);
        if (parts.length === 0) {
          await updateOwned(COL.statements, st.id, { parts: [], nbRows: 0, status: "empty" });
          patch(st.id, { parts: [], nbRows: 0, status: "empty" });
          return;
        }

        const cur: Statement = { ...st, parts, nbRows: totalRows, status: "ready" };
        await updateOwned(COL.statements, st.id, { parts, nbRows: totalRows, status: "ready" });
        patch(st.id, { parts, nbRows: totalRows, status: "ready" });

        // Aucun rattachement manuel : chaque compte détecté est rattaché à un
        // compte existant (par IBAN/banque) ou créé automatiquement, puis importé.
        await importAllParts(cur);
        // Flux internes : dès le 2ᵉ relevé, on relie automatiquement les miroirs.
        await detectAndLinkFlows();
      } catch (e) {
        const msg = (e as Error).message;
        await updateOwned(COL.statements, st.id, { status: "error", error: msg });
        patch(st.id, { status: "error", error: msg });
      }
    },
    [importAllParts, detectAndLinkFlows, patch]
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
        const st = (await listOwned<Statement>(COL.statements)).map(normalizeStatement).find((s) => s.id === id);
        if (!st) continue; // supprimé entre-temps
        try {
          const canFinish =
            st.status === "ready" &&
            (st.parts ?? []).some((p) => !p.imported && (p.rows?.length ?? 0) > 0);
          // « ready » : import déjà scanné → on finit sans ré-appeler l'IA.
          if (canFinish) {
            await importAllParts(st);
            await detectAndLinkFlows();
          } else await processStatement(st);
        } catch (e) {
          try {
            await updateOwned(COL.statements, id, { status: "error", error: (e as Error).message });
            patch(id, { status: "error", error: (e as Error).message });
          } catch {
            /* doc supprimé pendant le traitement : on ignore */
          }
        }
      }
    } finally {
      runningRef.current = false;
    }
  }, [processStatement, importAllParts, detectAndLinkFlows, patch]);

  const enqueue = useCallback(
    (ids: string[]) => {
      queueRef.current.push(...ids);
      void drain();
    },
    [drain]
  );

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
      // Reprend les traitements interrompus : « processing » (à ré-analyser) ET
      // « ready » (analysé mais import non terminé).
      const stuck = list.filter((s) => s.status === "processing" || s.status === "ready");
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
          parts: [],
          nbRows: 0,
        });
        const st: Statement = {
          id,
          ownerUid: "",
          fileName: file.name,
          fileHash: hash ?? null,
          storagePath: "",
          status: "processing",
          parts: [],
          nbRows: 0,
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

  /** Bascule Pro/Perso d'un compte détecté = met à jour le TYPE DU COMPTE. */
  const setPartUsage = useCallback(
    async (st: Statement, partKey: string, usage: Usage) => {
      const part = (st.parts ?? []).find((p) => p.key === partKey);
      const parts = (st.parts ?? []).map((p) =>
        p.key === partKey
          ? {
              ...p,
              detected: p.detected
                ? { ...p.detected, usage }
                : { banque: null, iban: null, titulaire: null, periode: null, usage },
            }
          : p
      );
      await updateOwned(COL.statements, st.id, { parts });
      patch(st.id, { parts });

      const accId = part?.resolvedAccountId;
      if (accId) {
        await updateOwned(COL.accounts, accId, { usage });
        accountsRef.current = accountsRef.current.map((a) => (a.id === accId ? { ...a, usage } : a));
        setAccounts((prev) => prev.map((a) => (a.id === accId ? { ...a, usage } : a)));
      }
    },
    [patch]
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

  /** Supprime un relevé ET, en cascade, toutes les transactions de ses imports. */
  const remove = useCallback(async (st: Statement) => {
    const importIds = (st.parts ?? [])
      .map((p) => p.importId)
      .filter(Boolean) as string[];
    if (importIds.length) {
      const all = await listOwned<Transaction>(COL.transactions);
      const set = new Set(importIds);
      const toDel = all.filter((t) => t.importId && set.has(t.importId));
      for (let i = 0; i < toDel.length; i += 400) {
        const b = writeBatch(db);
        for (const t of toDel.slice(i, i + 400)) b.delete(doc(db, COL.transactions, t.id));
        await b.commit();
      }
      for (const impId of importIds) {
        try {
          await deleteOwned(COL.imports, impId);
        } catch {
          /* déjà supprimé */
        }
      }
    }
    if (st.storagePath) await deleteFile(st.storagePath);
    await deleteOwned(COL.statements, st.id);
    filesRef.current.delete(st.id);
    // Libère l'empreinte : le même fichier peut être ré-importé après suppression.
    if (st.fileHash) importHashesRef.current.delete(st.fileHash);
    setStatements((prev) => prev.filter((s) => s.id !== st.id));
  }, []);

  const value: StatementsCtx = {
    ready,
    statements,
    progress,
    accounts,
    entities,
    addFiles,
    setPartUsage,
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
