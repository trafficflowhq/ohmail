import type { HostAddress, PhysicalLeave } from "./device.js";

type Ask = Parameters<HostAddress["holdLeave"]>[0];

function panePath(fragment: string): string {
  return fragment.split("?")[0]!.replace(/^#?\/?/, "");
}

/** One dirty pane at a time owns the leave question. A discarded or superseded question cannot move a later pane. */
export function leaveHold(changed: (held: boolean) => void = () => {}) {
  let current: { ask: Ask; leaves: (next: string) => boolean; attempt: number } | null = null;
  function holdLeave(ask: Ask, at: string, leaves = (next: string) => panePath(next) !== panePath(at)) {
    const hold = { ask, leaves, attempt: 0 };
    current = hold;
    changed(true);
    return () => {
      if (current !== hold) return;
      current = null;
      changed(false);
    };
  }
  function leaving(next: string): boolean {
    // The query and an optional leading hash do not change which Settings pane owns its draft.
    return current?.leaves(next) ?? false;
  }
  function heldBefore(
    next: string,
    resume: () => void | Promise<boolean>,
    physical?: PhysicalLeave,
  ): boolean {
    const hold = current;
    if (hold === null || !leaving(next)) return false;
    const attempt = ++hold.attempt;
    const live = () => current === hold && hold.attempt === attempt && !physical?.signal.aborted;
    let chosen = false;
    hold.ask((drop) => {
      if (chosen || !live()) return;
      chosen = true;
      const release = () => {
        current = null;
        changed(false);
        drop?.();
      };
      if (physical) {
        void Promise.resolve(resume()).then((accepted) => {
          if (accepted && live()) release();
        });
      } else {
        release();
        void resume();
      }
    }, physical);
    return true;
  }
  return { holdLeave, heldBefore, leaving };
}
