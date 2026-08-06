"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { COL, createOwned, deleteOwned, listOwned } from "@/lib/db";
import type { AccountingCode, BankAccount, Entity } from "@/lib/types";
import { useAuth } from "@/lib/auth";

// Plan comptable par défaut PROPOSÉ (seed éditable, pas codé en dur dans la
// logique) — comptes usuels attendus par la spéc §6.
const DEFAULT_PLAN: { code: string; libelle: string }[] = [
  { code: "607", libelle: "Achats de marchandises" },
  { code: "606", libelle: "Achats non stockés (fournitures, énergie)" },
  { code: "611", libelle: "Sous-traitance" },
  { code: "613", libelle: "Locations" },
  { code: "615", libelle: "Entretien et réparations" },
  { code: "616", libelle: "Assurances" },
  { code: "618", libelle: "Services extérieurs divers" },
  { code: "6226", libelle: "Honoraires" },
  { code: "625", libelle: "Déplacements, missions, réceptions" },
  { code: "626", libelle: "Frais postaux et télécoms" },
  { code: "627", libelle: "Services bancaires" },
  { code: "641", libelle: "Rémunérations du personnel" },
  { code: "645", libelle: "Charges sociales" },
  { code: "512", libelle: "Banque" },
  { code: "455", libelle: "Compte courant d'associé" },
  { code: "44566", libelle: "TVA déductible" },
  { code: "44571", libelle: "TVA collectée" },
  { code: "21", libelle: "Immobilisations corporelles" },
];

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
  const [codes, setCodes] = useState<AccountingCode[]>([]);
  const [loading, setLoading] = useState(true);

  async function reload() {
    const [e, a, c] = await Promise.all([
      listOwned<Entity>(COL.entities),
      listOwned<BankAccount>(COL.accounts),
      listOwned<AccountingCode>(COL.codes),
    ]);
    setEntities(e);
    setAccounts(a);
    setCodes(c.sort((x, y) => x.code.localeCompare(y.code)));
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

  // --- Plan comptable
  const [cCode, setCCode] = useState("");
  const [cLabel, setCLabel] = useState("");
  async function addCode(ev: React.FormEvent) {
    ev.preventDefault();
    if (!cCode.trim() || !cLabel.trim()) return;
    await createOwned(COL.codes, { code: cCode.trim(), libelle: cLabel.trim() });
    setCCode("");
    setCLabel("");
    reload();
  }
  async function seedDefaults() {
    const existing = new Set(codes.map((c) => c.code));
    for (const d of DEFAULT_PLAN) {
      if (!existing.has(d.code)) await createOwned(COL.codes, d);
    }
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

      {/* Plan comptable éditable (§6) */}
      <section style={{ marginTop: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ fontSize: 16 }}>Plan comptable</h2>
          {codes.length === 0 && (
            <button className="btn secondary" onClick={seedDefaults}>
              Charger le plan par défaut
            </button>
          )}
        </div>
        <form onSubmit={addCode} className="card" style={{ marginBottom: 12 }}>
          <div className="row">
            <div className="field" style={{ width: 120 }}>
              <label>Code</label>
              <input value={cCode} onChange={(e) => setCCode(e.target.value)} placeholder="645" />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Libellé</label>
              <input value={cLabel} onChange={(e) => setCLabel(e.target.value)} placeholder="Charges sociales" />
            </div>
            <button className="btn" style={{ alignSelf: "flex-end" }}>Ajouter</button>
          </div>
        </form>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {codes.map((c) => (
            <div
              key={c.id}
              className="card"
              style={{ padding: "8px 12px", display: "flex", gap: 10, alignItems: "center" }}
            >
              <strong>{c.code}</strong>
              <span className="muted">{c.libelle}</span>
              <button
                onClick={() => deleteOwned(COL.codes, c.id).then(reload)}
                style={{ background: "none", border: "none", color: "var(--red)", fontWeight: 700 }}
                title="Supprimer"
              >
                ×
              </button>
            </div>
          ))}
          {codes.length === 0 && <p className="muted">Aucun compte dans le plan.</p>}
        </div>
      </section>
    </div>
  );
}
