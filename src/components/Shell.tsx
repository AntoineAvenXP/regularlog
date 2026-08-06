"use client";

import { type ReactNode, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

const NAV = [
  { href: "/", label: "Tableau de bord" },
  { href: "/transactions", label: "Transactions" },
  { href: "/flux", label: "Flux internes" },
  { href: "/justificatifs", label: "Justificatifs" },
  { href: "/validation", label: "File de validation" },
  { href: "/imports", label: "Imports" },
  { href: "/export", label: "Export" },
  { href: "/regles", label: "Règles" },
  { href: "/parametres", label: "Paramètres" },
];

export default function Shell({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading) return <div className="center muted">Chargement…</div>;
  if (!user) return null;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Regularlog</div>
        <nav>
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={pathname === n.href ? "active" : ""}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <button className="logout" onClick={() => logout()}>
          Déconnexion
        </button>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
