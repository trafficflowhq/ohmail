"use client";

/**
 * The pane-foot hint — the contextual teaching layer (ohmarchy Phase 1). The hand-typed legend it
 * replaces drifted from the bindings it claimed to document (it once taught `y` bound nowhere) and
 * clipped mid-word; it was cut to one item, `? shortcuts`. The teaching line is back — GENERATED,
 * never typed: the foot shows the section-scoped movement hints, read from the live registry by
 * the dispatcher's own precedence, and the zone model flips those bindings' disabled flags as
 * focus crosses tiles — it cannot name a key that does nothing and cannot survive a deleted
 * binding.
 */

/**
 * Two laws (owner rulings, OHMARCHY-PLAN §12): the foot carries ONLY section-level navigation and
 * scope hints — verbs teach on their own buttons — and teaching intensity is a token (`--teach`),
 * not a fork. Clipping is structural: the teaching tail gets `min-width:0` + ellipsis while
 * `? shortcuts` stays `flex:none`, so at the narrowest column the hints truncate honestly and the
 * affordance that documents everything never does. Registry rules unchanged: no provider or
 * nothing bound means NO hint — never a guessed one — and `useKeyPress`'s click IS the keypress
 * (see `Registry.press` for the stale-closure double-toggle this avoids).
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Kbd } from "@ohmail/ui";
import { isTypingTarget, useBinding, useEnabledBinding, useKeyPress } from "./keymap";
import "./shortcut-hint.css";

/** One generated hint: the keycaps and the winning binding's own label. */
function MoveHint({ caps, label }: { caps: string[]; label: string }) {
  return (
    <span className="key-hint-move">
      {caps.map((c) => (
        <Kbd key={c}>{c}</Kbd>
      ))}{" "}
      {label}
    </span>
  );
}

export function ShortcutHint() {
  const t = useTranslations("shortcuts");
  const bound = useBinding("?");
  const press = useKeyPress();
  /* One direction per axis, the forward one, with its own label — a printed cap must mean exactly
     what its label says: "↑ ↓ next message" mislabels ↑, and both directions with both labels
     doubles the foot's width. So each axis teaches its forward step (↓, →) and flips to the
     surviving direction at an edge — every cap live, every label the binding's own, the reverse key
     one `?` away (review, rounds 1–2). The foot's fidelity is the registry's, exactly — a stated
     limit (round 3): edge-flipping happens where a view DECLARES its edges, and an
     internally-bounded walk stays declared-live at its last stop because the registry has no edge
     model for it — the `?` sheet lists the same binding as live in the same state. Teaching chrome
     must not grow a private focus tracker to out-know the dispatcher it documents. */
  const up = useEnabledBinding("ArrowUp");
  const down = useEnabledBinding("ArrowDown");
  const right = useEnabledBinding("ArrowRight");
  const left = useEnabledBinding("ArrowLeft");
  /* SILENT WHILE A CARET OWNS THE ARROWS. With focus in an editor or field the arrow keys
     move the caret (the registry's typing guard, and the scroll pair's own `when`), so a
     foot advertising them would be teaching keys that will not fire (review finding,
     round 2). Same derivation the dispatcher uses, kept current by the focus events. */
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const read = (): void => setTyping(isTypingTarget(document.activeElement));
    const onFocusOut = (): void => {
      void Promise.resolve().then(read);
    };
    document.addEventListener("focusin", read);
    document.addEventListener("focusout", onFocusOut);
    /* A focused node REMOVED by a sibling-only commit (the rail's rename input) blurs
       silently and renders nothing here (review finding, round 4) — so the next KEYDOWN
       also re-reads: the moment a hint could matter again, a key was pressed, and the
       residual window fails QUIET (hints hidden, never a false one). */
    document.addEventListener("keydown", read);
    read();
    return () => {
      document.removeEventListener("focusin", read);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", read);
    };
  }, []);
  /* Re-read after EVERY commit, zone-nav's own remedy for the same hole: a REMOVED focused
     editor blurs silently (no focusout), which left `typing` stuck true and the hints
     suppressed until the next focus event (review finding, round 3). An editor unmounting
     re-registers keymap layers, so a commit reaches this component; `setTyping` with an
     unchanged value schedules no render, so the steady state costs one read per commit. */
  useEffect(() => {
    setTyping(isTypingTarget(document.activeElement));
  });
  if (!bound || bound.disabled) return null;
  /* An axis whose two live directions share ONE label (the reader's scroll pair) prints
     the PAIR — no preference asserted, both caps true (review round 4). Directional labels
     print the forward one; where the walk's far edge is unmodelled (the rail's last row)
     that can name a bounded no-op, and it stays that way deliberately: the edge is
     unknowable without probing focus-refusal — `tryFocus` only discovers an edge by
     attempting it — and teaching chrome must not out-model the dispatcher it documents. */
  const axis = (
    fwd: { cap: string; b: typeof up },
    back: { cap: string; b: typeof up },
  ): { caps: string[]; label: string } | null => {
    if (typing) return null;
    if (fwd.b && back.b && fwd.b.label === back.b.label)
      return { caps: [back.cap, fwd.cap], label: fwd.b.label };
    if (fwd.b) return { caps: [fwd.cap], label: fwd.b.label };
    if (back.b) return { caps: [back.cap], label: back.b.label };
    return null;
  };
  const vertical = axis({ cap: "↓", b: down }, { cap: "↑", b: up });
  const lateral = axis({ cap: "→", b: right }, { cap: "←", b: left });
  return (
    <span className="key-hints">
      {vertical ? <MoveHint caps={vertical.caps} label={vertical.label} /> : null}
      {lateral ? <MoveHint caps={lateral.caps} label={lateral.label} /> : null}
      <button type="button" className="key-hint" aria-haspopup="dialog" onClick={() => press("?")}>
        <Kbd>?</Kbd> {t("hint")}
      </button>
    </span>
  );
}
