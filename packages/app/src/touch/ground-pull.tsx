/**
 * THE MAIL GROUND'S PULL, FOR A LIST UNDER A FINGER: the one Pull new mail the rail's foot, `p` and the list's menu
 * press, as the touch layer takes it; none outside the mail ground. `PullScroll` is a list's own scroller with that
 * pull at its top, for a list that ends on its own sheet.
 */
import type { ReactNode, RefObject } from "react";
import { usePull } from "@ohmail/app-logic/session/pull-new-mail";
import { NONE, type None } from "../host/index.js";
import type { ListPull } from "./contract.js";
import { ListTouch } from "./ListTouch.js";

export function useGroundPull(): ListPull | None {
  const ground = usePull();
  return ground === null ? NONE : { busy: ground.pulling, run: ground.pull };
}

export function PullScroll({
  className,
  scroller,
  children,
}: {
  readonly className: string;
  readonly scroller: RefObject<HTMLDivElement | null>;
  readonly children: ReactNode;
}) {
  const pull = useGroundPull();
  return (
    <div className={className} ref={scroller}>
      <ListTouch scroller={scroller} run={false} pull={pull}>
        {children}
      </ListTouch>
    </div>
  );
}
