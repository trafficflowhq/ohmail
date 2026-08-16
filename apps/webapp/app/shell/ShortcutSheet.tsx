"use client";

/**
 * The `?` sheet — every binding that is live right now, and nothing else.
 *
 * It renders `groupedBindings(useKeymap().bindings)` and holds no list of its own. That is
 * the property worth protecting: the previous "documentation" was a sentence in the (i)
 * panel that somebody typed once, and by the time this was written it named keys that had
 * moved and omitted the ones that had arrived. A sheet built from the dispatcher's own
 * table cannot do either. `test/keymap.test.ts` mutates the generation to watch it fail.
 *
 * A peek, not a mode: ANY key dismisses it and then does its normal job, so `?` `j` reads
 * the map and moves the cursor in two keystrokes.
 */
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Icon, Kbd } from "@ohmail/ui";
import { chordKeys, groupedBindings, useKeymap, type BindingGroup } from "./keymap";

/**
 * `KeyboardEvent.key` values that are a modifier being held, not a keystroke being made.
 * `AltGraph` and `CapsLock` are here for the same reason as the four obvious ones: a user
 * reaching for a chord on a non-US layout presses them on the way to a character.
 */
const MODIFIER_KEYS = new Set([
  "Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "ScrollLock",
  "Fn", "FnLock", "Hyper", "Super", "Symbol", "SymbolLock",
]);

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("shortcuts");
  const { bindings } = useKeymap();

  useEffect(() => {
    if (!open) return;
    // Any keypress dismisses. The registry's own listener still runs the binding for that
    // key — the sheet is in the way of nothing.
    //
    // ── EXCEPT A BARE MODIFIER, AND THAT EXCEPTION IS THE WHOLE OF THE TOGGLE ──────────
    //
    // "Any key dismisses and then does its normal job" is the peek design, and a modifier
    // held down on its own has no normal job — it is the first half of a chord the user has
    // not finished typing. Counting it as a dismissal broke `?` on every layout where `?`
    // needs Shift, which is most of them: the chord arrives as TWO keydowns, `Shift` closed
    // the sheet, and `?` then reached the registry toggle, found it closed, and re-opened
    // it. Pressing `?` to close the sheet left the sheet open.
    //
    // Not cosmetic — the sheet is `position: fixed` over the whole deck, so a sheet that
    // will not close swallows the click the user makes next. It ate the bulk bar's "Mark
    // read" for weeks and was read as a bulk-selection bug.
    //
    // With modifiers ignored the chord behaves: `Shift` does nothing, then `?` both
    // dismisses here and toggles in the registry — and those AGREE, because both are
    // closing an open sheet.
    const onKey = (e: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(e.key)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const groups = groupedBindings(bindings);
  const groupLabel = (g: BindingGroup) => t(`group.${g}` as "group.navigate");

  return (
    <>
      <div className="ks-bg" onClick={onClose} />
      <div className="ks" role="dialog" aria-modal="true" aria-label={t("title")}>
        <div className="ks-head">
          <h3>
            <Icon name="open" /> {t("title")}
          </h3>
          <button type="button" className="x" aria-label={t("close")} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="ks-cols">
          {groups.map((g) => (
            <section key={g.group}>
              <h4>{groupLabel(g.group)}</h4>
              <ul>
                {g.items.map((b) => (
                  <li key={b.chord} className={b.disabled ? "off" : undefined}>
                    <span className="ks-keys">
                      {chordKeys(b.chord).map((k, i) => (
                        <Kbd key={`${k}-${i}`}>{k}</Kbd>
                      ))}
                    </span>
                    <span className="ks-lab">{b.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="ks-foot">{t("foot")}</p>
      </div>
    </>
  );
}
