"use client";

/**
 * THE PANE-FOOT KEY HINT — one affordance, `? shortcuts`, in place of a legend.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * Every list pane pinned a strip under its scroller reading
 * "j k move · ↵ read · t tag · x select · u unread · ? all keys". The strip was clamped to
 * one line with `overflow:hidden`, so in the split layout — a list pane sharing the window
 * with a reading column — it CLIPPED mid-word and sat there as permanently truncated chrome.
 * It was also a hand-maintained second list of the bindings, which is the exact artifact the
 * keyboard registry deleted from the (i) panel and the Screener's strip had already been
 * caught getting wrong (`y accept suggestion`, with `y` bound nowhere).
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────────────────
 *
 * One item: the key whose job is to document the rest. It cannot clip, because it is a few
 * characters at a pane foot that is never that narrow; it cannot drift, because the sheet it
 * opens is GENERATED from the registry (`ShortcutSheet`); and it teaches the only thing a
 * legend taught that the interface does not already carry — that `?` exists. The keys
 * themselves are documented where they act: the action bar's capsules print their chords
 * (`useBinding`), the Screener's decision capsules wear theirs, and the sheet lists what a
 * key does HERE, by the dispatcher's own precedence walk.
 *
 * ── THE TWO REGISTRY RULES IT OBEYS ─────────────────────────────────────────────────────
 *
 *  · `useBinding`: no provider, or no `?` in it, means NO hint — never a guessed one. The
 *    desktop shell and several tests mount these views with no keymap at all.
 *  · `useKeyPress`: the click IS the keypress. Calling a memoised binding's `run` directly
 *    executes a stale closure (see `Registry.press` in `keymap.tsx` for the double-toggle
 *    this caused); `press` resolves the handler at click time, so the button and the key
 *    are one code path.
 */
import { useTranslations } from "next-intl";
import { Kbd } from "@ohmail/ui";
import { useBinding, useKeyPress } from "./keymap";
import "./shortcut-hint.css";

export function ShortcutHint() {
  const t = useTranslations("shortcuts");
  const bound = useBinding("?");
  const press = useKeyPress();
  if (!bound || bound.disabled) return null;
  return (
    <button type="button" className="key-hint" aria-haspopup="dialog" onClick={() => press("?")}>
      <Kbd>?</Kbd> {t("hint")}
    </button>
  );
}
