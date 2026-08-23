"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import Shell from "@/components/Shell";
import { PageHeader } from "@/components/PageHeader";
import BridgePanel from "@/components/BridgePanel";
import StatementImport from "@/components/StatementImport";
import TabularImport from "@/components/TabularImport";
import { COL, listOwned } from "@/lib/db";
import { weakKey } from "@/lib/importWrite";
import type { BankAccount, Entity, ImportBatch, Transaction } from "@/lib/types";
import { useAuth } from "@/lib/auth";

export default function ImportsPage() {
  return (
    <Shell>
      <Imports />
    </Shell>
  );
}

function Imports() {
  const { user } = useAuth();
  const [entities, setEntities] = useState<Entity[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [fpByAccount, setFpByAccount] = useState<Record<string, Set<string>>>({});
  const [bridgeByAccount, setBridgeByAccount] = useState<
    Record<string, Map<string, string>>
  >({});
  const [existingFileHashes, setExistingFileHashes] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [e, a, tx, imports] = await Promise.all([
      listOwned<Entity>(COL.entities),
      listOwned<BankAccount>(COL.accounts),
      listOwned<Transaction>(COL.transactions),
      listOwned<ImportBatch>(COL.imports),
    ]);
    setEntities(e);
    setAccounts(a);
    // Dédup ligne à ligne : empreintes des transactions NON-Bridge uniquement
    // (les doublons Bridge sont écrasés par l'upload, cf. bridgeByAccount).
    const fp: Record<string, Set<string>> = {};
    const bridge: Record<string, Map<string, string>> = {};
    for (const t of tx) {
      if (t.origine === "bridge") {
        (bridge[t.bankAccountId] ??= new Map()).set(
          weakKey(t.dateOperation, t.montant),
          t.id
        );
      } else {
        (fp[t.bankAccountId] ??= new Set()).add(t.fingerprint);
      }
    }
    setFpByAccount(fp);
    setBridgeByAccount(bridge);
    setExistingFileHashes(
      new Set(imports.map((i) => i.fileHash).filter(Boolean) as string[])
    );
  }, []);

  useEffect(() => {
    if (user) reload();
  }, [user, reload]);

  const onImported = useCallback(
    (n: number) => {
      setDone(
        n > 0
          ? `${n} transaction(s) importée(s).`
          : "Rien à importer (doublons ou lignes déjà présentes)."
      );
      reload();
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [reload]
  );

  return (
    <div>
      <PageHeader
        title="Imports"
        subtitle="Le point de départ : connecte tes banques, dépose tes relevés, reconstitue tes comptes."
      />

      {done && (
        <div
          className="card"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderColor: "var(--green)",
            color: "var(--green-dark)",
            marginBottom: 16,
          }}
        >
          <CheckCircle2 size={18} />
          {done}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <BridgePanel entities={entities} accounts={accounts} onReload={reload} />

        <StatementImport
          entities={entities}
          accounts={accounts}
          fpByAccount={fpByAccount}
          bridgeByAccount={bridgeByAccount}
          existingFileHashes={existingFileHashes}
          onImported={onImported}
          onAccountsChanged={() => reload()}
        />

        <TabularImport
          entities={entities}
          accounts={accounts}
          fpByAccount={fpByAccount}
          bridgeByAccount={bridgeByAccount}
          existingFileHashes={existingFileHashes}
          onImported={onImported}
        />
      </div>
    </div>
  );
}
