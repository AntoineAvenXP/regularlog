"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace("/");
  }, [loading, user, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await login(email, password);
      router.replace("/");
    } catch {
      setErr("Identifiants incorrects.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form onSubmit={submit} className="card login">
        <h1>Regularlog</h1>
        <p className="muted" style={{ margin: 0 }}>
          Reconstitution comptable
        </p>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Mot de passe"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {err && <div className="error">{err}</div>}
        <button disabled={busy}>{busy ? "…" : "Se connecter"}</button>
      </form>
    </div>
  );
}
