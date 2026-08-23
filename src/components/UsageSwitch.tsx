"use client";

import { Briefcase, User, LayoutGrid } from "lucide-react";
import { useUsageFilter } from "@/lib/usageFilter";
import type { UsageMode } from "@/lib/usage";

const OPTS: { value: UsageMode; label: string; Icon: typeof LayoutGrid }[] = [
  { value: "tout", label: "Tout", Icon: LayoutGrid },
  { value: "pro", label: "Pro", Icon: Briefcase },
  { value: "perso", label: "Perso", Icon: User },
];

/** Bascule globale Tout / Pro / Perso, affichée en haut de chaque page. */
export default function UsageSwitch() {
  const { mode, setMode } = useUsageFilter();
  return (
    <div className="usagebar">
      <span className="usagebar-label">Vue</span>
      <div className="seg" role="tablist" aria-label="Filtre pro/perso">
        {OPTS.map(({ value, label, Icon }) => (
          <button
            key={value}
            role="tab"
            aria-selected={mode === value}
            className={mode === value ? "active" : ""}
            onClick={() => setMode(value)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
