import type { ReactNode, Ref, UIEventHandler } from "react";
import "./side-panel.css";

export interface SidePanelProps {
  /** The panel's name: "Agenda", "Invitations". */
  label: string;
  /** Its head: the name and the close. */
  head: ReactNode;
  /** What scrolls: groups of rows. */
  children: ReactNode;
  /** What stays at the panel's foot, over the list's end: the open event's verbs. */
  foot?: ReactNode;
  /** It has just been asked for: it slides in; taking another panel's place, it only fades. */
  arrives?: "slide" | "swap";
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}

/**
 * A panel beside a view: the Agenda, Invitations. One of them at a time, shut until it is asked
 * for; nothing of it floats over the days. Where it stands beside the view is the app's layout.
 */
export function SidePanel({ label, head, children, foot, arrives, scrollRef, onScroll }: SidePanelProps) {
  return (
    <aside className="oh-calside" aria-label={label} data-foot={foot ? "" : undefined} data-arrives={arrives}>
      {head}
      <div className="oh-calside-scroll" ref={scrollRef} onScroll={onScroll}>
        {children}
      </div>
      {foot ? <div className="oh-calside-foot">{foot}</div> : null}
    </aside>
  );
}
