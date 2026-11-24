import type { CSSProperties } from "react";
import { design } from "../tokens.js";
import "./dot.css";

export interface DotProps {
  /**
   * `hot`: something is open. `ink`: done. `ring`: it came back. `todo`: a step still ahead, a ring in the
   * second ink. `none`: its place, kept empty.
   */
  kind: "hot" | "ink" | "ring" | "todo" | "none";
  /** The dot of one of the two apps, in that app's own colour whichever app is open. */
  product?: "mail" | "cal";
  /** Somebody is at the door: it knocks, and a ring leaves it once. */
  ringing?: boolean;
  /** The dot is a control (the mark's doorbell): its name, and what a press does. */
  press?: { label: string; onPress: () => void };
}

/* An app's own colour in both schemes, as the tokens hold it. Ohmarchy has one accent, the theme's. */
const own = (product: "mail" | "cal"): CSSProperties => {
  const { light, dark } = design.accents[design.productAccent[product]].paper;
  return { "--oh-dot-light": light.hot, "--oh-dot-dark": dark.hot } as CSSProperties;
};
const OWN = { mail: own("mail"), cal: own("cal") };

/**
 * The full stop. It ends a title, a sentence, a report; it is drawn, never typed, and says nothing to a screen
 * reader. Where it is pressed it is a button of the same size on the same line, named by its label; a finger
 * reaches it as far as the smallest control.
 */
export function Dot({ kind, product, ringing, press }: DotProps) {
  const drawn = {
    "data-kind": kind,
    "data-product": product,
    "data-ringing": ringing ? "" : undefined,
    style: product ? OWN[product] : undefined,
  };
  if (press)
    return (
      <button
        type="button"
        className="oh-control oh-dot"
        data-press=""
        aria-label={press.label}
        onClick={press.onPress}
        {...drawn}
      />
    );
  return <i className="oh-dot" aria-hidden="true" {...drawn} />;
}
