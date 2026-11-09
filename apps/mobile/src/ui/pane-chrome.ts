/**
 * What the list pane's chrome carries on the big-screen postures — provided by `ListDetail`,
 * read by `TopBar`, its own module so the two do not import each other. Present = a two-pane
 * surface with a drawer behind the list pane's toggle (the unfolded Duo, the iPad); null = the
 * ordinary chrome, unchanged.
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

/**
 * True inside one pane of the list-detail pair, which pays the rail's column itself; false
 * everywhere else, where a `Screen` fills the window and pays it (`screenFillsWindow`).
 */
export const InPaneContext = createContext(false);

export function useInPane(): boolean {
  return useContext(InPaneContext);
}

/**
 * What a list owes at its foot for what stands below it in the pane (the iPad's Search and New
 * mail pills, under the list's fade): it rests that far above its edge, and the foot pays the
 * window's inset. 0 = nothing below; the list pays the inset itself.
 */
export const ListFootContext = createContext(0);

export function useListFoot(): number {
  return useContext(ListFootContext);
}
