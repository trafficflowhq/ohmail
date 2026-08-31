"use client";

/**
 * THE PANE-FOOT HINT — the contextual teaching layer (ohmarchy Phase 1), grown from the
 * one-affordance strip.
 *
 * ── WHAT THIS WAS, AND WHAT IT REFUSES TO BECOME AGAIN ─────────────────────────────────
 *
 * Every list pane used to pin a HAND-TYPED legend under its scroller ("j k move · ↵ read ·
 * t tag · x select · u unread · ? all keys") — clamped to one line, clipping mid-word in
 * the split layout, and drifting from the bindings it claimed to document (the Screener's
 * strip once taught `y accept suggestion` with `y` bound nowhere). It was cut down to ONE
 * item, `? shortcuts`, precisely because a second list of the bindings is the artifact the
 * keyboard registry deleted from the (i) panel.
 *
 * The ohmarchy keymap brings the teaching line back — but GENERATED, never typed. The foot
 * now shows the SECTION-SCOPED MOVEMENT HINTS: what ↑↓ and ←→ do right here, read from the
 * live registry by the dispatcher's own precedence (the first ENABLED binding wins — the
 * same rule the `?` sheet dedups by). The zone model flips those bindings' disabled flags
 * as focus crosses tiles, so the foot re-teaches itself per section with no state of its
 * own. It CANNOT name a key that does nothing and cannot survive a deleted binding — the
 * property the one-affordance design existed to protect, kept under more content.
 *
 * ── THE TWO LAWS IT OBEYS (owner rulings, OHMARCHY-PLAN §12) ───────────────────────────
 *
 *  · The foot carries ONLY section-level navigation and scope hints — never a verb that
 *    owns a visible button. Verbs teach on their own buttons (`.abar kbd`, the Key
 *    component); movement has no button, so movement is what a statusline may say.
 *  · Teaching INTENSITY is a token, not a fork: the contract's `--teach`
 *    (OHMARCHY-CONTRACT.md — 0 for paper, 1 for ohmarchy, defined only in the token
 *    stylesheet's face blocks) decides how loudly this renders. Paper's 0 is the strips'
 *    own 11px `--ink3` register; the ohmarchy face resolves the same rules louder later.
 *
 * ── CLIPPING, STRUCTURALLY ──────────────────────────────────────────────────────────────
 *
 * The old legend's defect was clipping MID-WORD as permanent chrome. The foot keeps the
 * strips' one-line guarantee and gives the teaching tail `min-width:0` + ellipsis while
 * `? shortcuts` stays `flex:none` — so at the narrowest split column the hints truncate
 * honestly and the affordance that documents everything never does (shortcut-hint.css).
 *
 * ── THE REGISTRY RULES, UNCHANGED ──────────────────────────────────────────────────────
 *
 *  · `useBinding`/`useEnabledBinding`: no provider, or nothing bound, means NO hint —
 *    never a guessed one. The desktop shell and several tests mount these views bare.
 *  · `useKeyPress`: the click IS the keypress — `press("?")` resolves the handler at
 *    click time (see `Registry.press` for the stale-closure double-toggle this avoids).
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
  /* ONE DIRECTION PER AXIS, the forward one, with ITS OWN label — a printed cap must mean
     exactly what its label says. The first per-direction draft printed "↑ ↓ next message",
     which mislabels ↑; printing both directions with both labels would double the foot's
     width for a teaching line. So each axis teaches its forward step (↓, →) and flips to
     the surviving direction at an edge (↑ at the bottom, ← inside the reader) — every cap
     live, every label the binding's own, the reverse key one `?` away (review findings,
     rounds 1–2).

     THE FOOT'S FIDELITY IS THE REGISTRY'S, EXACTLY — a stated limit, not an oversight
     (review round 3): edge-flipping happens where a view DECLARES its edges (the list
     pairs' `disabled` tracks the cursor), and an internally-bounded walk (the rail step,
     the reader scroll) stays declared-live at its last stop because the registry has no
     edge model for it anywhere — the `?` sheet lists the same binding as live in the same
     state. Teaching chrome must not grow a private focus-position tracker to out-know the
     dispatcher it documents; if an edge matters enough to model, it is modelled in the
     binding, and the foot follows for free. */
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
