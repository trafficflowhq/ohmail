/**
 * What the list pane's chrome carries on the big-screen postures — provided by `ListDetail`,
 * read by `TopBar`, its own module so the two do not import each other. Present = a two-pane
 * surface with a drawer behind the list pane's toggle (the unfolded Duo, the iPad, Android
 * two-pane); null = the ordinary one-pane chrome, unchanged.
 */
import { createContext, useContext } from "react";

export interface PaneChrome {
  /** The sidebar toggle, top-left of the list pane (prototype v5) — opens the drawer. */
  openDrawer: () => void;
}

export const PaneChromeContext = createContext<PaneChrome | null>(null);

export function usePaneChrome(): PaneChrome | null {
  return useContext(PaneChromeContext);
}
