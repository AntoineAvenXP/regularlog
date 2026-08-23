"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import Shell from "@/components/Shell";
import { PageHeader } from "@/components/PageHeader";
import BridgePanel from "@/components/BridgePanel";
import StatementImport from "@/components/StatementImport";
import TabularImport from "@/components/TabularImport";
import { COL, listOwned } from "@/lib/db";
import type { BankAccount, Entity, Transaction } from "@/lib/types";
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
  const [done, setDone] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [e, a, tx] = await Promise.all([
      listOwned<Entity>(COL.entities),
      listOwned<BankAccount>(COL.accounts),
      listOwned<Transaction>(COL.transactions),
    ]);
    setEntities(e);
    setAccounts(a);
    const map: Record<string, Set<string>> = {};
    for (const t of tx) {
      (map[t.bankAccountId] ??= new Set()).add(t.fingerprint);
    }
    setFpByAccount(map);
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
          onImported={onImported}
          onAccountsChanged={() => reload()}
        />

        <TabularImport
          entities={entities}
          accounts={accounts}
          fpByAccount={fpByAccount}
          onImported={onImported}
        />
      </div>
    </div>
  );
}
