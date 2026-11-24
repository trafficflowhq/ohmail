import type { ReactNode } from "react";
import { Dot } from "../../base/index.js";
import { Icon } from "../../icons/Icon.js";

/**
 * A row to tick: a checkbox, ticked or not, with its tick at the row's end. A press, Space or Enter is `onOpen`.
 * It is named by what it shows: who, how many (`amountSaid`), and the address as its second line, which may break
 * after its @. `settled`: the ticks were taken: it takes no press any more, and a ticked row ends in the dot.
 */
export interface RowTick {
  on: boolean;
  settled?: boolean;
}

/** The tick at a row's end: the check while it can be ticked; once the ticks were taken, the dot of a ticked row. */
export function RowTickMark({ tick }: { tick: RowTick }) {
  return (
    <i className="oh-row-tick">
      {tick.settled ? tick.on ? <Dot kind="ink" /> : null : <Icon name="check" size={16} />}
    </i>
  );
}

/**
 * An amount in the time's place. Handed its words, the figure is a picture named by them ("2 messages" for "2×"):
 * a name hung on a plain box is a name a screen reader may never say, and "2×" read out is a letter.
 */
export function RowAmount({ figure, said }: { figure: string; said?: string }) {
  return (
    <span className="oh-row-amount" role={said ? "img" : undefined} aria-label={said}>
      {figure}
    </span>
  );
}

/** An address that may break after its @ where its line is too short for it, instead of being cut. */
export function breakable(address: string): ReactNode {
  const at = address.indexOf("@") + 1;
  return at > 0 ? (
    <>
      {address.slice(0, at)}
      <wbr />
      {address.slice(at)}
    </>
  ) : (
    address
  );
}
