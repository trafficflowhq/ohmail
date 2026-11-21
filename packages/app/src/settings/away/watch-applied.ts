import type { RefObject } from "react";
import type { HostWires } from "../../host/index.js";
import type { AwayRefusal } from "./model.js";

type AwayWire = Exclude<HostWires["away"], "none">;
export type AwayResponderWire = Awaited<ReturnType<AwayWire["state"]>>;

const ASKED_POLL_MS = 20_000;
const ASKED_POLL_MAX = 12;

/** The organizer's refusal, if the row reports one. */
export function refusalOf(wire: AwayResponderWire): AwayRefusal | null {
  const { change } = wire;
  return change?.state === "refused" ? { holder: change.holder, refusal: change.refusal } : null;
}

/** A changed row ends polling. The pane's model decides whether it matches the request. */
export function watchAwayApplied(
  wire: AwayWire,
  askedAt: string | null,
  current: () => boolean,
  timer: RefObject<ReturnType<typeof setTimeout> | null>,
  heard: (response: AwayResponderWire, refusal: AwayRefusal | null) => void,
): void {
  let left = ASKED_POLL_MAX;
  const tick = (): void => {
    timer.current = setTimeout(async () => {
      if (!current()) return;
      left -= 1;
      try {
        const response = await wire.state();
        if (!current()) return;
        const refused = refusalOf(response);
        if (refused !== null || response.updatedAt !== askedAt) {
          heard(response, refused);
          return;
        }
      } catch {
        /* A refused read is not an answer about the request: still waiting. */
      }
      if (left > 0) tick();
    }, ASKED_POLL_MS);
  };
  tick();
}
