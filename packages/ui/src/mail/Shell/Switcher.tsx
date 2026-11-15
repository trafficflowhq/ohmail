import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { KeyHint } from "../../base/index.js";
import { design } from "../../base/tokens.js";
import { Icon } from "../../icons/Icon.js";
import { animate } from "../../motion/motion.js";
import "./switcher.css";

export type SwitcherProduct = "mail" | "cal";

export interface SwitcherSide {
  /** The product's wordmark without its dot: "ohmail". */
  word: string;
  /** The side's name, and what its hint says. */
  label: string;
  title?: string;
  /** The keys that go there, drawn where key hints are shown. */
  keyHint?: string;
  /** Something on that side waits for you. Only the round button shows it. */
  wants?: boolean;
  /** The other app is not on this device: its side stands quieter, in the ring of what can be added. */
  absent?: boolean;
}

export interface SwitcherProps {
  /** `pair`: one capsule of two halves. `round`: one round button that shows where it leads. */
  kind: "pair" | "round";
  /** The pair's name: "Mail or Calendar". */
  label: string;
  /** The product you are in. */
  current: SwitcherProduct;
  mail: SwitcherSide;
  cal: SwitcherSide;
  /** Key hints are switched on: each half shows its keys. */
  keysShown?: boolean;
  /** The round button stands in an upright rail of icons. */
  onRail?: boolean;
  onSwitch?: (to: SwitcherProduct) => void;
}

const SIGN = { mail: "mail", cal: "calendar" } as const;

/* The four properties each product's dot is set in, by name: paper light and dark, ohmarchy light and dark. */
const DOT = {
  mail: {
    pl: "--oh-switcher-mail-pl",
    pd: "--oh-switcher-mail-pd",
    ol: "--oh-switcher-mail-ol",
    od: "--oh-switcher-mail-od",
  },
  cal: {
    pl: "--oh-switcher-cal-pl",
    pd: "--oh-switcher-cal-pd",
    ol: "--oh-switcher-cal-ol",
    od: "--oh-switcher-cal-od",
  },
} as const;

/* Each product's dot wears that product's own colour, whichever product is open: the four values the
   tokens hold for it, one of which the stylesheet picks by the document's face and scheme. Ohmarchy
   has one accent, the theme's own, so both dots wear it there. */
function dotColours(): CSSProperties {
  const out: Record<string, string> = {};
  const own = design.accents[design.productAccent.mail].ohmarchy;
  for (const product of ["mail", "cal"] as const) {
    const accent = design.accents[design.productAccent[product]];
    out[DOT[product].pl] = accent.paper.light.hot;
    out[DOT[product].pd] = accent.paper.dark.hot;
    out[DOT[product].ol] = own.light.hot;
    out[DOT[product].od] = own.dark.hot;
  }
  return out as CSSProperties;
}
const COLOURS = dotColours();

/** Mail or Calendar: the way between the two products, in the same place in both. */
export function Switcher({ kind, label, current, mail, cal, keysShown, onRail, onSwitch }: SwitcherProps) {
  const knob = useRef<HTMLElement>(null);
  const stood = useRef<DOMRect | null>(null);
  const sides = { mail, cal };

  /* The ink half is one element: it slides to the side you go to. */
  useLayoutEffect(() => {
    const el = knob.current;
    const now = el ? el.getBoundingClientRect() : null;
    const was = stood.current;
    stood.current = now;
    if (!el || !now || !was || now.width === 0 || (was.left === now.left && was.width === now.width)) return;
    const from = `translateX(${was.left - now.left}px) scaleX(${was.width / now.width})`;
    animate(el, "knob", { ease: "--e-knob", keyframes: [{ transform: from }, { transform: "none" }] });
  }, [current]);

  if (kind === "round") {
    const to: SwitcherProduct = current === "mail" ? "cal" : "mail";
    const side = sides[to];
    return (
      <button
        type="button"
        className="oh-switcher-round"
        data-rail={onRail ? "" : undefined}
        data-absent={side.absent ? "" : undefined}
        aria-label={side.label}
        title={side.title}
        style={COLOURS}
        onClick={onSwitch && (() => onSwitch(to))}
      >
        <Icon name={SIGN[to]} size={20} />
        {side.wants ? <i className="oh-switcher-wants" data-product={to} /> : null}
      </button>
    );
  }
  return (
    <div
      className="oh-switcher"
      role="group"
      aria-label={label}
      data-current={current}
      data-keys={keysShown ? "" : undefined}
      style={COLOURS}
    >
      <i ref={knob} className="oh-switcher-knob" aria-hidden="true" />
      {(["mail", "cal"] as const).map((product) => {
        const side = sides[product];
        return (
          <button
            key={product}
            type="button"
            className="oh-switcher-half"
            aria-current={current === product ? "true" : undefined}
            aria-label={side.label}
            title={side.title}
            data-absent={side.absent ? "" : undefined}
            onClick={onSwitch && (() => onSwitch(product))}
          >
            <span className="oh-switcher-sign">
              <Icon name={SIGN[product]} size={18} />
            </span>
            <span className="oh-switcher-word">
              {side.word}
              <i className="oh-switcher-dot" data-product={product} />
            </span>
            {side.keyHint && keysShown ? (
              <span className="oh-switcher-key">
                <KeyHint shown>{side.keyHint}</KeyHint>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
