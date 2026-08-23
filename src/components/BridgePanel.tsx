"use client";

import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { Cable, Link2, RefreshCw, Landmark } from "lucide-react";
import { SectionHeader } from "@/components/PageHeader";
import { COL, createOwned, updateOwned } from "@/lib/db";
import { functions } from "@/lib/firebase";
import type { BankAccount, Entity } from "@/lib/types";

type BridgeAccount = { id: string; name: string; iban: string | null };

/**
 * Connexion bancaire Bridge (T6). Point d'entrée des imports automatiques :
 * connecter ses banques, voir ses comptes Bridge, synchroniser maintenant.
 */
export default function BridgePanel({
  entities,
  accounts,
  onReload,
}: {
  entities: Entity[];
  accounts: BankAccount[];
  onReload: () => void;
}) {
  const [bridgeAccounts, setBridgeAccounts] = useState<BridgeAccount[] | null>(
    null
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgKind, setMsgKind] = useState<"ok" | "err">("ok");

  const linkedIds = new Set(
    accounts.map((a) => a.bridgeAccountId).filter(Boolean) as string[]
  );

  function ok(m: string) {
    setMsg(m);
    setMsgKind("ok");
  }
  function err(m: string) {
    setMsg(m);
    setMsgKind("err");
  }

  async function connect() {
    setBusy("connect");
    setMsg(null);
    try {
      const fn = httpsCallable<unknown, { url: string }>(
        functions,
        "bridgeConnect"
      );
      const { data } = await fn({});
      if (data.url) window.open(data.url, "_blank");
      else err("Aucune URL de connexion renvoyée.");
    } catch (e) {
      err("Erreur Bridge : " + (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function loadAccounts() {
    setBusy("list");
    setMsg(null);
    try {
      const fn = httpsCallable<unknown, { accounts: BridgeAccount[] }>(
        functions,
        "bridgeListAccounts"
      );
      const { data } = await fn({});
      setBridgeAccounts(data.accounts);
      if (data.accounts.length === 0)
        ok("Aucun compte trouvé. Connecte d'abord une banque.");
    } catch (e) {
      err("Erreur Bridge : " + (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function sync() {
    setBusy("sync");
    setMsg(null);
    try {
      const fn = httpsCallable<unknown, { added: number; skipped: number }>(
        functions,
        "bridgeSync"
      );
      const { data } = await fn({});
      ok(`Synchro terminée : ${data.added} ajoutée(s), ${data.skipped} ignorée(s).`);
    } catch (e) {
      err("Erreur Bridge : " + (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function linkAccount(b: BridgeAccount, entityId: string) {
    const existingSameEntity = accounts.find(
      (a) => a.entityId === entityId && !a.bridgeAccountId
    );
    if (
      existingSameEntity &&
      window.confirm(
        `Relier au compte existant « ${existingSameEntity.libelle} » ? (Annuler = créer un nouveau compte)`
      )
    ) {
      await updateOwned(COL.accounts, existingSameEntity.id, {
        bridgeAccountId: b.id,
        source: "bridge",
      });
    } else {
      await createOwned(COL.accounts, {
        entityId,
        banque: b.name,
        libelle: b.name,
        ibanPartiel: b.iban ? b.iban.slice(-4) : null,
        source: "bridge" as const,
        bridgeAccountId: b.id,
      });
    }
    onReload();
    ok("Compte rattaché.");
  }

  return (
    <section className="card">
      <SectionHeader icon={Cable} title="Connexion bancaire (Bridge)" />
      <p className="muted" style={{ marginTop: 0, marginBottom: 16, fontSize: 12.5 }}>
        Remontée automatique des transactions récentes. Les relevés anciens
        restent importés manuellement ci-dessous (Bridge ne remonte que les
        12-24 derniers mois).
      </p>
      <div className="toolbar" style={{ marginBottom: msg ? 12 : 0 }}>
        <button className="btn dark" onClick={connect} disabled={!!busy}>
          <Landmark />
          {busy === "connect" ? "Ouverture…" : "Connecter mes banques"}
        </button>
        <button className="btn secondary" onClick={loadAccounts} disabled={!!busy}>
          <Link2 />
          {busy === "list" ? "Chargement…" : "Voir mes comptes Bridge"}
        </button>
        <button className="btn secondary" onClick={sync} disabled={!!busy}>
          <RefreshCw />
          {busy === "sync" ? "Synchro…" : "Synchroniser maintenant"}
        </button>
      </div>
      {msg && (
        <p
          style={{
            fontSize: 13,
            margin: "4px 0 0",
            color: msgKind === "err" ? "var(--red)" : "var(--green-dark)",
          }}
        >
          {msg}
        </p>
      )}

      {bridgeAccounts && bridgeAccounts.length > 0 && (
        <table className="grid" style={{ maxWidth: 720, marginTop: 14 }}>
          <thead>
            <tr>
              <th>Compte Bridge</th>
              <th>IBAN</th>
              <th>Rattachement Regularlog</th>
            </tr>
          </thead>
          <tbody>
            {bridgeAccounts.map((b) => (
              <tr key={b.id}>
                <td>{b.name}</td>
                <td className="muted">{b.iban ?? "—"}</td>
                <td>
                  {linkedIds.has(b.id) ? (
                    <span className="badge rattache">rattaché</span>
                  ) : (
                    <select
                      defaultValue=""
                      onChange={(e) =>
                        e.target.value && linkAccount(b, e.target.value)
                      }
                    >
                      <option value="">— rattacher à une entité —</option>
                      {entities.map((en) => (
                        <option key={en.id} value={en.id}>
                          {en.denomination}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
