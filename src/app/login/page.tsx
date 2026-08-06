"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { ContourLines, DotGrid, Fan } from "@/components/Decor";

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
      {/* Décor de marque */}
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
        <ContourLines style={{ position: "absolute", top: -30, left: -60, width: 620, opacity: 0.5 }} />
        <Fan className="" size={300} style={{ position: "absolute", top: -30, right: -20 }} />
        <DotGrid style={{ position: "absolute", bottom: 60, left: 90, opacity: 0.8 }} />
        <Fan size={180} style={{ position: "absolute", bottom: -30, left: -40, transform: "rotate(180deg)", opacity: 0.5 }} />
      </div>

      <form onSubmit={submit} className="card login">
        <div className="login-top">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Regularlog" />
          <div className="tag">Reconstitution comptable</div>
        </div>
        <div className="login-body">
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
          <button className="btn" disabled={busy} style={{ width: "100%", padding: 12 }}>
            {busy ? "…" : "Se connecter"}
          </button>
        </div>
      </form>
    </div>
  );
}
