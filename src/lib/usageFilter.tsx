"use client";

// Filtre global Pro / Perso — état partagé par toute l'app (Transactions,
// Tableau de bord, Export). Persisté en localStorage pour survivre au refresh.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { UsageMode } from "./usage";

const KEY = "rl_usage_mode";

interface Ctx {
  mode: UsageMode;
  setMode: (m: UsageMode) => void;
}

const UsageFilterContext = createContext<Ctx>({
  mode: "tout",
  setMode: () => {},
});

export function UsageFilterProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<UsageMode>("tout");

  // Lecture initiale (client uniquement).
  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(KEY) : null;
    if (saved === "pro" || saved === "perso" || saved === "tout") setMode(saved);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(KEY, mode);
  }, [mode]);

  const value = useMemo(() => ({ mode, setMode }), [mode]);
  return (
    <UsageFilterContext.Provider value={value}>
      {children}
    </UsageFilterContext.Provider>
  );
}

export function useUsageFilter(): Ctx {
  return useContext(UsageFilterContext);
}
