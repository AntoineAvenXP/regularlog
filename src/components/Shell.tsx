"use client";

import { type ReactNode, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutGrid,
  ArrowRightLeft,
  Repeat,
  FileText,
  ClipboardCheck,
  Download,
  Upload,
  Workflow,
  Settings,
  LogOut,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { ContourLines, DotGrid, Fan } from "@/components/Decor";

const NAV = [
  { href: "/", label: "Tableau de bord", Icon: LayoutGrid },
  { href: "/transactions", label: "Transactions", Icon: ArrowRightLeft },
  { href: "/flux", label: "Flux internes", Icon: Repeat },
  { href: "/justificatifs", label: "Justificatifs", Icon: FileText },
  { href: "/validation", label: "File de validation", Icon: ClipboardCheck },
  { href: "/imports", label: "Imports", Icon: Download },
  { href: "/export", label: "Export", Icon: Upload },
  { href: "/regles", label: "Règles", Icon: Workflow },
  { href: "/parametres", label: "Paramètres", Icon: Settings },
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
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="Regularlog" className="brand-logo" />
          <div className="brand-name">RegularLog</div>
        </div>
        <nav>
          {NAV.map(({ href, label, Icon }) => (
            <Link key={href} href={href} className={pathname === href ? "active" : ""}>
              <Icon />
              {label}
            </Link>
          ))}
        </nav>
        <button className="logout" onClick={() => logout()}>
          <LogOut />
          Déconnexion
        </button>
      </aside>

      <main className="content">
        <div className="decor" aria-hidden="true">
          <ContourLines className="decor-contour" />
          <DotGrid className="decor-dots" />
          <Fan className="decor-fan" />
        </div>
        <div className="content-inner">{children}</div>
      </main>
    </div>
  );
}
