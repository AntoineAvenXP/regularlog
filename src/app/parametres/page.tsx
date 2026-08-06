"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { COL, createOwned, deleteOwned, listOwned } from "@/lib/db";
import type { BankAccount, Entity } from "@/lib/types";
import { useAuth } from "@/lib/auth";

export default function ParametresPage() {
  return (
    <Shell>
      <Parametres />
    </Shell>
  );
}

function Parametres() {
  const { user } = useAuth();
  const [entities, setEntities] = useState<Entity[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);

  async function reload() {
    const [e, a] = await Promise.all([
      listOwned<Entity>(COL.entities),
      listOwned<BankAccount>(COL.accounts),
    ]);
    setEntities(e);
    setAccounts(a);
    setLoading(false);
  }
  useEffect(() => {
    if (user) reload();
  }, [user]);

  // --- Formulaire entité
  const [eName, setEName] = useState("");
  const [eType, setEType] = useState<"societe" | "personnel">("societe");
  const [eSiren, setESiren] = useState("");
  async function addEntity(ev: React.FormEvent) {
    ev.preventDefault();
    if (!eName.trim()) return;
    await createOwned(COL.entities, {
      denomination: eName.trim(),
      type: eType,
      siren: eSiren.trim() || null,
    });
    setEName("");
    setESiren("");
    reload();
  }

  // --- Formulaire compte
  const [aEntity, setAEntity] = useState("");
  const [aBanque, setABanque] = useState("");
  const [aLibelle, setALibelle] = useState("");
  const [aIban, setAIban] = useState("");
  async function addAccount(ev: React.FormEvent) {
    ev.preventDefault();
    if (!aEntity || !aBanque.trim() || !aLibelle.trim()) return;
    await createOwned(COL.accounts, {
      entityId: aEntity,
      banque: aBanque.trim(),
      libelle: aLibelle.trim(),
      ibanPartiel: aIban.trim() || null,
      source: "import" as const,
      bridgeAccountId: null,
    });
    setABanque("");
    setALibelle("");
    setAIban("");
    reload();
  }

  if (loading) return <p className="muted">Chargement…</p>;

  const entName = (id: string) =>
    entities.find((e) => e.id === id)?.denomination ?? "—";

  return (
    <div>
      <h1 className="page">Paramètres</h1>
      <p className="sub">Entités et comptes bancaires</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Entités */}
        <section>
          <h2 style={{ fontSize: 16 }}>Entités</h2>
          <form onSubmit={addEntity} className="card" style={{ marginBottom: 12 }}>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Dénomination</label>
              <input value={eName} onChange={(e) => setEName(e.target.value)} placeholder="Ma société / Moi" />
            </div>
            <div className="row" style={{ marginBottom: 10 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Type</label>
                <select value={eType} onChange={(e) => setEType(e.target.value as "societe" | "personnel")}>
                  <option value="societe">Société</option>
                  <option value="personnel">Personnel</option>
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>SIREN (optionnel)</label>
                <input value={eSiren} onChange={(e) => setESiren(e.target.value)} />
              </div>
            </div>
            <button className="btn">Ajouter l&apos;entité</button>
          </form>
          {entities.map((e) => (
            <div key={e.id} className="card" style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>{e.denomination}</strong>
                <span className="muted"> · {e.type}{e.siren ? ` · ${e.siren}` : ""}</span>
              </div>
              <button className="btn secondary" onClick={() => deleteOwned(COL.entities, e.id).then(reload)}>
                Supprimer
              </button>
            </div>
          ))}
          {entities.length === 0 && <p className="muted">Aucune entité.</p>}
        </section>

        {/* Comptes */}
        <section>
          <h2 style={{ fontSize: 16 }}>Comptes bancaires</h2>
          <form onSubmit={addAccount} className="card" style={{ marginBottom: 12 }}>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Entité de rattachement</label>
              <select value={aEntity} onChange={(e) => setAEntity(e.target.value)}>
                <option value="">— choisir —</option>
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>{e.denomination}</option>
                ))}
              </select>
            </div>
            <div className="row" style={{ marginBottom: 10 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Banque</label>
                <input value={aBanque} onChange={(e) => setABanque(e.target.value)} placeholder="Qonto, BNP…" />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Libellé du compte</label>
                <input value={aLibelle} onChange={(e) => setALibelle(e.target.value)} placeholder="Compte courant pro" />
              </div>
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>IBAN partiel (optionnel)</label>
              <input value={aIban} onChange={(e) => setAIban(e.target.value)} placeholder="…1234" />
            </div>
            <button className="btn" disabled={entities.length === 0}>Ajouter le compte</button>
            {entities.length === 0 && <p className="muted" style={{ marginTop: 8 }}>Crée d&apos;abord une entité.</p>}
          </form>
          {accounts.map((a) => (
            <div key={a.id} className="card" style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>{a.libelle}</strong>
                <span className="muted"> · {a.banque} · {entName(a.entityId)}{a.ibanPartiel ? ` · ${a.ibanPartiel}` : ""}</span>
              </div>
              <button className="btn secondary" onClick={() => deleteOwned(COL.accounts, a.id).then(reload)}>
                Supprimer
              </button>
            </div>
          ))}
          {accounts.length === 0 && <p className="muted">Aucun compte.</p>}
        </section>
      </div>
    </div>
  );
}
