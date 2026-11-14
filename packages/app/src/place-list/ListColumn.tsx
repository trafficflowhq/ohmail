/**
 * A list place's column: its head, then its own scroller; on a phone's width the rows lie on one sheet. Every list
 * beside the reading column stands in it (the list places, the streams, the piles, Drafts).
 */
import type { ReactNode, Ref } from "react";
import { Sheet } from "@ohmail/ui/mail";
import type { LayoutPlan } from "../frame/contract.js";
import "./place-list.css";

export function ListColumn({
  head,
  plan,
  label,
  rootRef,
  scrollerRef,
  children,
}: {
  head: ReactNode;
  plan: LayoutPlan;
  /** Names the column as a region, where the place has no other name for it. */
  label?: string;
  rootRef?: Ref<HTMLDivElement>;
  scrollerRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      className="pl-list"
      ref={rootRef}
      role={label === undefined ? undefined : "region"}
      aria-label={label}
    >
      {head}
      <div className="pl-scroll" ref={scrollerRef} tabIndex={-1}>
        {plan.device === "phone" ? (
          <div className="pl-page">
            <Sheet kind="plain">{children}</Sheet>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
