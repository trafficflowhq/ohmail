"use client";

/**
 * The `?` sheet — every binding that is live right now, and nothing else. It renders
 * `groupedBindings(useKeymap().bindings)` and holds no list of its own: the previous
 * "documentation" was a sentence somebody typed once, and by the time this was written it named
 * keys that had moved and omitted ones that had arrived — a sheet built from the dispatcher's own
 * table cannot do either (`test/keymap.test.ts` mutates the generation to watch it fail). A peek,
 * not a mode: any key dismisses it and then does its normal job, so `?` `j` reads the map and
 * moves the cursor in two keystrokes.
 */
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Icon, Kbd } from "@ohmail/ui";
import {
  chordKeys, groupedBindings, useKeymap,
  type BindingGroup, type DisabledReason, type KeyBinding,
} from "./keymap";

/**
 * `KeyboardEvent.key` values that are a modifier being held, not a keystroke being made.
 * `AltGraph` and `CapsLock` are here for the same reason as the four obvious ones: a user
 * reaching for a chord on a non-US layout presses them on the way to a character.
 */
const MODIFIER_KEYS = new Set([
  "Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "ScrollLock",
  "Fn", "FnLock", "Hyper", "Super", "Symbol", "SymbolLock",
]);

/** One printed row: an instruction, the chords that reach it, and why it is inert here. */
interface Row {
  label: string;
  chords: string[];
  disabled: boolean;
  /**
   * WHY it is inert here, when a binding on the row said so — see `KeyBinding.disabledReason`.
   * Folded exactly as `disabled` is: kept only while every chord on the row rests for the SAME
   * reason, because a row is one instruction with several spellings.
   */
  reason: DisabledReason | undefined;
}

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("shortcuts");
  /* Trash's reasons live in their own namespace, where the view that raises them reads them. */
  const tRoot = useTranslations();
  const { bindings, mod } = useKeymap();

  useEffect(() => {
    if (!open) return;
    // Any keypress dismisses; the registry's own listener still runs the binding — the sheet is in
    // the way of nothing. EXCEPT a bare modifier, and that exception is the whole of the toggle: a
    // held modifier has no normal job — it is the first half of an unfinished chord. Counting it as
    // a dismissal broke `?` on every layout where `?` needs Shift: the chord arrives as two
    // keydowns, `Shift` closed the sheet, and `?` reached the registry toggle, found it closed, and
    // re-opened it — pressing `?` to close the sheet left it open. Not cosmetic: the sheet is
    // `position: fixed` over the whole deck, so it swallowed the next click (it ate the bulk bar's
    // "Mark read" for weeks, read as a bulk-selection bug). With modifiers ignored the chord
    // behaves: `Shift` does nothing, then `?` both dismisses here and toggles in the registry.
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
  /**
   * ONE ROW PER SENTENCE. Two chords that do the same thing — `1` and `g o` both go to the
   * Ohbox — are one instruction with two spellings, so they share a row rather than listing
   * every destination twice. Folded on the LABEL, which is the registry's own text: the digit
   * bindings borrow the `g` chord's sentence for exactly this reason. A row is inert only when
   * every chord on it is.
   */
  /* ONE SENTENCE PER TOKEN — a `Record` over the union, so a new reason in `keymap.tsx` is a
     type error here until somebody writes its words. */
  const REASON_TEXT: Record<DisabledReason, string> = {
    no_cursor: t("needsCursor"),
    no_erase: tRoot("trash.noErase"),
    trash_unavailable: tRoot("trash.unavailable"),
  };
  const rows = (items: KeyBinding[]): Row[] => {
    const out: Row[] = [];
    for (const b of items) {
      /* WHY THE ROW SAYS SO. Until this sheet carried the sentence, a greyed row was the ONLY
         place a person could learn that a verb was resting, and it did not say what for — the
         report that started this was "⌫ does nothing", from an Ohbox whose list had simply never
         been touched. `no_cursor` is the one reason with a remedy the reader can act on, so it is
         the one that gets a sentence; a row resting because a message has nobody to reply to all
         of has nothing to tell them to do.

         FOLDED THE SAME WAY `disabled` IS, and it has to be: a row is one instruction with
         several spellings, and it only needs a cursor if EVERY chord on it is waiting for one. */
      const reason = b.disabled === true ? b.disabledReason : undefined;
      const row = out.find((r) => r.label === b.label);
      if (row) {
        row.chords.push(b.chord);
        row.disabled = row.disabled && Boolean(b.disabled);
        if (row.reason !== reason) row.reason = undefined;
      } else out.push({ label: b.label, chords: [b.chord], disabled: Boolean(b.disabled), reason });
    }
    return out;
  };

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
                {rows(g.items).map((row) => (
                  <li
                    key={row.chords[0]}
                    className={row.disabled ? "off" : undefined}
                    /* The reason, on the row that has one. A `title` and not a visible line: the
                       sheet is a scan of forty rows and a sentence under every greyed one would
                       bury the ones that are live. */
                    {...(row.reason ? { title: REASON_TEXT[row.reason] } : {})}
                  >
                    <span className="ks-keys">
                      {row.chords.map((chord, c) => (
                        <span key={chord} className="ks-chord">
                          {c > 0 ? <span className="ks-or" aria-hidden="true">·</span> : null}
                          {chordKeys(chord, mod).map((k, i) => (
                            <Kbd key={`${k}-${i}`}>{k}</Kbd>
                          ))}
                        </span>
                      ))}
                    </span>
                    <span className="ks-lab">{row.label}</span>
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
