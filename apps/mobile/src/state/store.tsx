/**
 * The React binding over `model.ts`. Thin on purpose: it holds the state, hands
 * out the pure transitions, and does nothing else. Every rule lives in the
 * model, where the test suite can reach it without a renderer.
 *
 * There is no persistence and no network in this store. The demo world is an
 * offline preview of Mila's fixtures — quitting the app resets it, which is the
 * honest behaviour for a fixture world and one less thing pretending to be an
 * account. (A live session's mirror is a different store on purpose: it
 * persists, per account, through the client engine.)
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import * as M from "./model";

export interface Store {
  s: M.AppState;
  markSeen: (id: string) => void;
  markSeenThrough: (place: "reads" | "receipts", ids: string[]) => void;
  decide: (senderId: string, dest: M.Destination, read: boolean) => void;
  applyAllSuggestions: () => void;
  allowScreened: (id: string, dest: M.Place) => void;
  notSpam: (id: string, dest: M.Place) => void;
  setScope: (id: string, scope: M.Scope) => void;
  toggleTag: (messageId: string, tag: Parameters<typeof M.toggleTag>[2]) => void;
  addToPile: (kind: M.PileKind, item: M.PileItem) => void;
  removeFromPile: (kind: M.PileKind, id: string) => void;
  setTheme: (pref: M.ThemePref) => void;
  toggleNotification: (id: string) => void;
  resolveVipSuggestion: (accept: boolean) => void;
  setReadsChip: (v: M.AppState["readsChip"]) => void;
  undo: () => void;
  dismissToast: () => void;
}

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore() outside <StoreProvider>");
  return store;
}

/** Convenience: the state alone, for read-only screens. */
export function useApp(): M.AppState {
  return useStore().s;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<M.AppState>(M.initialState);
  const apply = useCallback((f: (prev: M.AppState) => M.AppState) => setS(f), []);

  const value = useMemo<Store>(
    () => ({
      s,
      markSeen: (id) => apply((p) => M.markSeen(p, id)),
      markSeenThrough: (place, ids) => apply((p) => M.markSeenThrough(p, place, ids)),
      decide: (senderId, dest, read) => apply((p) => M.decide(p, senderId, dest, read)),
      applyAllSuggestions: () => apply(M.applyAllSuggestions),
      allowScreened: (id, dest) => apply((p) => M.allowScreened(p, id, dest)),
      notSpam: (id, dest) => apply((p) => M.notSpam(p, id, dest)),
      setScope: (id, scope) => apply((p) => M.setScope(p, id, scope)),
      toggleTag: (messageId, tag) => apply((p) => M.toggleTag(p, messageId, tag)),
      addToPile: (kind, item) => apply((p) => M.addToPile(p, kind, item)),
      removeFromPile: (kind, id) => apply((p) => M.removeFromPile(p, kind, id)),
      setTheme: (pref) => apply((p) => M.setTheme(p, pref)),
      toggleNotification: (id) => apply((p) => M.toggleNotification(p, id)),
      resolveVipSuggestion: (accept) => apply((p) => M.resolveVipSuggestion(p, accept)),
      setReadsChip: (v) => apply((p) => M.setReadsChip(p, v)),
      undo: () => apply((p) => (p.toast?.undo ? M.undo(p, p.toast.undo) : p)),
      dismissToast: () => apply(M.dismissToast),
    }),
    [s, apply],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
