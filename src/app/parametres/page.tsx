"use client";

import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { Building2, Landmark, BookText, Cable } from "lucide-react";
import Shell from "@/components/Shell";
import { PageHeader, SectionHeader } from "@/components/PageHeader";
import { COL, createOwned, deleteOwned, listOwned, updateOwned } from "@/lib/db";
import { functions } from "@/lib/firebase";
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
      <PageHeader
        title="Paramètres"
        subtitle="Gérez vos entités, comptes bancaires et le plan comptable."
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Entités */}
        <section className="card">
          <SectionHeader icon={Building2} title="Entités" />
          <form onSubmit={addEntity} style={{ marginBottom: 12 }}>
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
            <button className="btn dark">Ajouter l&apos;entité</button>
          </form>
          {entities.map((e) => (
            <div key={e.id} style={{ marginBottom: 8, padding: "10px 14px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>{e.denomination}</strong>
                <span className="muted"> · {e.type}{e.siren ? ` · ${e.siren}` : ""}</span>
              </div>
              <button className="btn secondary" onClick={() => deleteOwned(COL.entities, e.id).then(reload)}>
                Supprimer
              </button>
            </div>
          ))}
          {entities.length === 0 && <div className="empty">Aucune entité.</div>}
        </section>

        {/* Comptes */}
        <section className="card">
          <SectionHeader icon={Landmark} title="Comptes bancaires" />
          <form onSubmit={addAccount} style={{ marginBottom: 12 }}>
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
            <div key={a.id} style={{ marginBottom: 8, padding: "10px 14px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>{a.libelle}</strong>
                <span className="muted"> · {a.banque} · {entName(a.entityId)}{a.ibanPartiel ? ` · ${a.ibanPartiel}` : ""}</span>
              </div>
              <button className="btn secondary" onClick={() => deleteOwned(COL.accounts, a.id).then(reload)}>
                Supprimer
              </button>
            </div>
          ))}
          {accounts.length === 0 && <div className="empty">Aucun compte.</div>}
        </section>
      </div>

      {/* Plan comptable éditable (§6) */}
      <section className="card" style={{ marginTop: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <SectionHeader icon={BookText} title="Plan comptable" />
          {codes.length === 0 && (
            <button className="btn secondary" onClick={seedDefaults}>
              Charger le plan par défaut
            </button>
          )}
        </div>
        <form onSubmit={addCode} style={{ marginBottom: 14 }}>
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
            <div key={c.id} className="pill">
              <strong>{c.code}</strong>
              <span className="muted">{c.libelle}</span>
              <button
                onClick={() => deleteOwned(COL.codes, c.id).then(reload)}
                style={{ background: "none", border: "none", color: "var(--red)", fontWeight: 700, padding: 0, lineHeight: 1 }}
                title="Supprimer"
              >
                ×
              </button>
            </div>
          ))}
          {codes.length === 0 && <div className="empty">Aucun compte dans le plan.</div>}
        </div>
      </section>

      <BridgeSection entities={entities} accounts={accounts} onReload={reload} />
    </div>
  );
}

// -------- Connexion bancaire Bridge (T6) --------
function BridgeSection({
  entities,
  accounts,
  onReload,
}: {
  entities: Entity[];
  accounts: BankAccount[];
  onReload: () => void;
}) {
  const [bridgeAccounts, setBridgeAccounts] = useState<
    { id: string; name: string; iban: string | null }[] | null
  >(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const linkedIds = new Set(accounts.map((a) => a.bridgeAccountId).filter(Boolean) as string[]);

  async function connect() {
    setBusy("connect");
    setMsg(null);
    try {
      const fn = httpsCallable<unknown, { url: string }>(functions, "bridgeConnect");
      const { data } = await fn({});
      if (data.url) window.open(data.url, "_blank");
      else setMsg("Aucune URL de connexion renvoyée.");
    } catch (e) {
      setMsg("Erreur Bridge : " + (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function loadAccounts() {
    setBusy("list");
    setMsg(null);
    try {
      const fn = httpsCallable<unknown, { accounts: { id: string; name: string; iban: string | null }[] }>(functions, "bridgeListAccounts");
      const { data } = await fn({});
      setBridgeAccounts(data.accounts);
    } catch (e) {
      setMsg("Erreur Bridge : " + (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function sync() {
    setBusy("sync");
    setMsg(null);
    try {
      const fn = httpsCallable<unknown, { added: number; skipped: number }>(functions, "bridgeSync");
      const { data } = await fn({});
      setMsg(`Synchro terminée : ${data.added} ajoutée(s), ${data.skipped} ignorée(s).`);
    } catch (e) {
      setMsg("Erreur Bridge : " + (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function linkAccount(b: { id: string; name: string; iban: string | null }, entityId: string) {
    // Rattache le compte Bridge : soit à un compte existant, soit en créant un.
    const existingSameEntity = accounts.find((a) => a.entityId === entityId && !a.bridgeAccountId);
    if (existingSameEntity && window.confirm(`Relier au compte existant « ${existingSameEntity.libelle} » ? (Annuler = créer un nouveau compte)`)) {
      await updateOwned(COL.accounts, existingSameEntity.id, { bridgeAccountId: b.id, source: "bridge" });
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
    setMsg("Compte rattaché.");
  }

  return (
    <section className="card" style={{ marginTop: 20 }}>
      <SectionHeader icon={Cable} title="Connexion bancaire (Bridge)" />
      <p className="muted" style={{ marginTop: 0, marginBottom: 14, fontSize: 12.5 }}>
        Remontée automatique des transactions récentes. Les relevés 2024 restent
        importés manuellement (Bridge ne remonte que les 12-24 derniers mois).
      </p>
      <div className="toolbar">
        <button className="btn dark" onClick={connect} disabled={!!busy}>
          {busy === "connect" ? "…" : "Connecter mes banques"}
        </button>
        <button className="btn secondary" onClick={loadAccounts} disabled={!!busy}>
          {busy === "list" ? "…" : "Voir mes comptes Bridge"}
        </button>
        <button className="btn secondary" onClick={sync} disabled={!!busy}>
          {busy === "sync" ? "Synchro…" : "Synchroniser maintenant"}
        </button>
      </div>
      {msg && <p style={{ fontSize: 13 }}>{msg}</p>}

      {bridgeAccounts && (
        <table className="grid" style={{ maxWidth: 720, marginTop: 8 }}>
          <thead>
            <tr><th>Compte Bridge</th><th>IBAN</th><th>Rattachement Regularlog</th></tr>
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
                      onChange={(e) => e.target.value && linkAccount(b, e.target.value)}
                    >
                      <option value="">— rattacher à une entité —</option>
                      {entities.map((en) => (
                        <option key={en.id} value={en.id}>{en.denomination}</option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            ))}
            {bridgeAccounts.length === 0 && (
              <tr><td colSpan={3} className="muted">Aucun compte. Clique d&apos;abord sur « Connecter mes banques ».</td></tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
