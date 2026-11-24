import { EventChip, type EventChipProps, type EventChipState } from "../../../src/calendar/index.js";
import type { KitSubject } from "../harness.js";

/**
 * Every chip of the calendar in every state, shut and open, one after the other in the keys' order:
 * the page `keys.compare.ts` walks with Tab. Each is named by what it is, so a ring on the wrong chip
 * is found by its name.
 */
const SIZES = ["block", "pill", "line"] as const;
const STATES: readonly EventChipState[] = ["plain", "to-answer", "from-mail", "draft", "maybe", "off"];

const chips = SIZES.flatMap((size) =>
  STATES.flatMap((state) =>
    [false, true].map((open) => ({ size, state, open, name: `${size} ${state}${open ? " open" : ""}` })),
  ),
);

/** The chips' names, in the order Tab reaches them. */
export const chipNames: string[] = chips.map((c) => c.name);

export const chipKeys: KitSubject = {
  key: "EventChip/keys",
  place: "block",
  width: 420,
  root: { product: "cal" },
  render: () => (
    <>
      {chips.map(({ size, state, open, name }) => {
        const props = {
          size,
          state,
          open,
          title: "Lunch with Anna",
          label: name,
          tone: state === "from-mail" ? null : 243,
          ...(size === "block" ? { place: { top: 0, height: 60 } } : {}),
          ...(size === "line" ? { time: "09:00" } : {}),
        } as EventChipProps;
        return (
          <div
            key={name}
            style={{ position: "relative", height: size === "block" ? 60 : 28, marginBottom: 8 }}
          >
            <EventChip {...props} />
          </div>
        );
      })}
    </>
  ),
};
