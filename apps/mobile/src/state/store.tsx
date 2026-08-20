/**
 * App-local preferences — the one piece of client state that is not the mirror.
 *
 * Today that is the theme choice alone. It is held in memory (a relaunch
 * returns to "system"); persisting it is a later, deliberate change, not a
 * side effect of some other store existing.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { ThemePref } from "./model";

export interface Prefs {
  themePref: ThemePref;
  setTheme: (pref: ThemePref) => void;
}

const PrefsContext = createContext<Prefs | null>(null);

export function usePrefs(): Prefs {
  const prefs = useContext(PrefsContext);
  if (!prefs) throw new Error("usePrefs() outside <PrefsProvider>");
  return prefs;
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [themePref, setTheme] = useState<ThemePref>("system");
  const value = useMemo<Prefs>(() => ({ themePref, setTheme }), [themePref]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}
