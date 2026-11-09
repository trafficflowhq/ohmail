/**
 * WHAT A DESTINATION OPEN IN MORE'S PANE NEEDS (two panes, `app/(tabs)/more.tsx`): the pick that
 * opens another destination in the same pane, and the ask before an unsaved edit leaves it. A pick
 * is a param change, not a navigation, so `usePreventRemove` never hears it; a form with an unsaved
 * edit registers here as well, and holds the reader moves (`reader-held`) so a fold keeps it in its
 * pane too.
 */
import { createContext, useContext, useEffect, useRef } from "react";
import { usePathname } from "expo-router";
import { holdReader } from "./reader-held";
import { isTabRoute } from "./scaffold/plan";

/** Present inside More's pair: opens a destination (a `pane-routes` key) beside More's rows. */
export const MorePickContext = createContext<((key: string) => void) | null>(null);

export function useMorePick(): ((key: string) => void) | null {
  return useContext(MorePickContext);
}

type Ask = (proceed: () => void) => void;
const asks: { ask: { current: Ask } }[] = [];

/** Runs `proceed` now, or hands it to the newest unsaved edit to ask first. */
export function askBeforePaneLeave(proceed: () => void): void {
  const last = asks[asks.length - 1];
  if (last === undefined) proceed();
  else last.ask.current(proceed);
}

/** While `unsaved`: a pane leave asks through `ask`, and a fold or an unfold waits. */
export function useUnsavedHold(unsaved: boolean, ask: Ask): void {
  const ref = useRef(ask);
  ref.current = ask;
  useEffect(() => {
    if (!unsaved) return undefined;
    const entry = { ask: ref };
    const token = Symbol("unsaved");
    asks.push(entry);
    holdReader(token, true);
    return () => {
      asks.splice(asks.indexOf(entry), 1);
      holdReader(token, false);
    };
  }, [unsaved]);
}

/**
 * Gives a hold back once any tab is in front again, which pops what was pushed over the tabs, or
 * once the screen holding it is gone (Search in More's pane, which stays mounted behind other tabs).
 */
export function ReleaseOnReturn({ token }: { token: symbol }): null {
  const onTab = isTabRoute(usePathname());
  useEffect(() => {
    if (onTab) holdReader(token, false);
  }, [onTab, token]);
  useEffect(() => () => holdReader(token, false), [token]);
  return null;
}
