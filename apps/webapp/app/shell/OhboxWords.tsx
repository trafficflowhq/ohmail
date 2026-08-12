"use client";

/**
 * "IN YOUR WORDS, WHAT BELONGS IN YOUR OHBOX" — the bar editor, once, for both tiers.
 *
 * The account's own sentence about what deserves the Ohbox. It is not decoration: it travels in the
 * USER turn of the screening question the classifier is asked about a first-contact sender, where
 * it is binding criteria rather than one input among several — asserted on the wire, under both of
 * the model providers a standalone install can use, by the mail engine's own end-to-end checks.
 *
 * ── WHY IT IS ITS OWN FILE ──────────────────────────────────────────────────────────────────
 *
 * Two surfaces edit the same column and must not become two editors. The hosted client reaches
 * `PATCH /account/screening` over `app/api-client`; a standalone desktop install reaches the SAME
 * route on the engine running on its own machine, over the shell's pipe. Those two transports have
 * nothing in common and the control has everything in common — the prefill rule, the inert Save,
 * what "clear the box" means — so the transport is a prop (`onSave`) and the rest lives here.
 *
 * That is also what keeps this file compilable in a browser tab AND in the desktop bundle: it names
 * no client, no bridge and no route. It takes a value and a function.
 *
 * ── THE PREFILL RULE, WHICH IS THE WHOLE DESIGN ─────────────────────────────────────────────
 *
 * When the account has never set a bar, the box is PREFILLED with the product default as editable
 * text rather than showing it greyed as a placeholder — you tweak words you can see instead of
 * staring at an empty box and guessing what saving it would do. "Save" therefore stays inert until
 * the text differs from the EFFECTIVE value (the stored bar, or the default when there is none), so
 * an untouched prefill writes nothing. Clearing the box entirely saves `null`, which is the
 * instruction "go back to the default" and not the instruction "screen against an empty sentence".
 *
 * ── THE PREFILL IS IN THE READER'S LANGUAGE, AND ONLY THE PREFILL ───────────────────────────────
 *
 * `defaultBar` is a SERVER constant (`DEFAULT_OHBOX_BAR`), and it is what the classifier is given
 * whenever the stored bar is NULL — so it is English, it is what a filing run was tested against,
 * and it is not this control's to translate. What a German reader was left with, though, was three
 * English sentences filling the one box that asks them to write in their own words. So the box
 * SHOWS `settings.screening.defaultBar` from the catalogue: English byte-identical to the constant,
 * German a twin. Display only. An untouched German account still stores NULL and the model still
 * receives the English constant. A drift guard over that pair holds the catalogue's English copy
 * byte-identical to the constant and fails, by name, if either moves without the other.
 *
 * That makes the inert-Save rule wider than "differs from the effective value", and the widening is
 * the load-bearing part rather than a nicety: under the narrow rule a German prefill differs from
 * the English constant on the first frame, so Save arms with nobody having typed and one press
 * converts a default account into a CUSTOM-BAR account holding a sentence no classifier run has
 * seen. EITHER language's default therefore counts as unchanged, and a save of one writes `null` —
 * "use the default" — never the twin's text. Both halves of that are mounted and driven in each
 * language by this editor's own locale suite.
 *
 * ── IT SHOWS WHAT THE SERVER CONFIRMED ──────────────────────────────────────────────────────
 *
 * `onSave` answers with the bar that was actually stored, and that answer — not the hoped-for
 * value — is what re-seeds the box. A failed write leaves the words where they were and shows one
 * plain sentence; there is no gate in front of this route with a more useful reason to offer.
 */

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";

import { DEFAULT_LOCALE } from "./locale";

export function OhboxWords({
  /** The stored bar, or `null` while this account has never set one. */
  bar,
  /**
   * The product default AS THE SERVER HOLDS IT — the English sentence the classifier is given while
   * the stored bar is NULL. It is not what the box displays (the catalogue's twin is), but it stays
   * one of the texts that count as "the default" so an engine whose constant has moved ahead of this
   * build still arms nothing on open.
   */
  defaultBar,
  /**
   * Write it. `null` means "revert to the default". Resolves with the bar the server confirmed
   * (`null` when it reverted); REJECTS to show the failure line — the reason is never invented here.
   */
  onSave,
  /** A sibling control on the same surface is mid-write. Disables this one; not a state of its own. */
  busy = false,
}: {
  bar: string | null;
  defaultBar: string;
  onSave: (next: string | null) => Promise<string | null>;
  busy?: boolean;
}) {
  const t = useTranslations("settings");

  /* THE DEFAULT IN THE READER'S LANGUAGE — what the box shows.
     English takes the SERVER's value verbatim rather than the catalogue's copy of it, and the
     asymmetry is deliberate: the server is the authority on the sentence the model is given, so an
     English reader sees exactly what the wire carried even if an engine's constant has moved ahead
     of this build. Any other language has no such option — a translation can only ever be OF the
     English the catalogue holds — so it takes the twin, and the drift guard named in the header is
     what keeps the English the twin was written against equal to the constant.
     A catalogue that somehow lacked the key would resolve to its own dotted path, and a textarea
     prefilled with `settings.screening.defaultBar` is worse than an English sentence; the server's
     value is the floor for that too. */
  const locale = useLocale();
  const fromCatalogue = t("screening.defaultBar");
  const shownDefault = locale !== DEFAULT_LOCALE && fromCatalogue.includes(" ")
    ? fromCatalogue
    : defaultBar;

  /* Seeded once, then owned here and re-seeded only from what a write CONFIRMED. A `useEffect` on
     the prop would fight the person typing: the parent re-renders for reasons that have nothing to
     do with this box, and each one would throw the draft away. */
  const [stored, setStored] = useState<string | null>(bar);
  const [draft, setDraft] = useState<string>(bar ?? shownDefault);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<"none" | "saved" | "failed">("none");

  /* THE LANGUAGE CAN CHANGE UNDER THIS BOX. The settings pane is re-rendered, not remounted, when
     the app's language is switched, so the draft survives the switch — and an untouched prefill
     that survived it would be the previous language's sentence sitting in a translated pane. It is
     re-seeded here, during render, and ONLY when it is still exactly the default it was seeded
     with: anything somebody has typed is theirs and is left alone. */
  const [seededFrom, setSeededFrom] = useState<string>(shownDefault);
  if (seededFrom !== shownDefault) {
    if (stored === null && draft.trim() === seededFrom.trim()) setDraft(shownDefault);
    setSeededFrom(shownDefault);
  }

  /**
   * IS THIS TEXT "THE DEFAULT"? Both spellings count — the server's English constant and the
   * sentence this reader is actually shown. Saying yes to either is what keeps a translated prefill
   * inert on open, and what keeps the twin's text out of the column: see the header.
   */
  const isDefaultText = (text: string): boolean => {
    const v = text.trim();
    return v === defaultBar.trim() || v === shownDefault.trim();
  };

  const effective = stored ?? shownDefault;
  const changed = stored === null
    ? !isDefaultText(draft)
    : draft.trim() !== effective.trim();
  const disabled = pending || busy;

  /** What a press stores. A default in any language, and an emptied box, are both `null`. */
  const toStore = (text: string): string | null =>
    isDefaultText(text) || !text.trim() ? null : text.trim();

  const save = (next: string | null): void => {
    if (disabled) return;
    setPending(true);
    setNote("none");
    void (async () => {
      try {
        const landed = await onSave(next);
        setStored(landed);
        setDraft(landed ?? shownDefault);
        setNote("saved");
      } catch {
        setNote("failed");
      } finally {
        setPending(false);
      }
    })();
  };

  return (
    <div className="set-screening-bar">
      <label className="set-note-inline" htmlFor="ohbox-bar">{t("screening.barLabel")}</label>
      <textarea
        id="ohbox-bar"
        className="set-screening-textarea"
        rows={4}
        value={draft}
        placeholder={shownDefault}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="gate-actions">
        <Button
          variant="primary"
          disabled={disabled || !changed}
          onClick={() => save(toStore(draft))}
        >
          {t("screening.save")}
        </Button>
        {/* Offered only when there is something to revert FROM — an account still on the default
            has nothing this button would change, and a control that does nothing is worse than
            no control. */}
        {stored !== null ? (
          <Button disabled={disabled} onClick={() => save(null)}>
            {t("screening.reset")}
          </Button>
        ) : null}
      </div>
      <p className="set-note-inline">{t("screening.microcopy")}</p>
      {note === "saved" ? <span className="scn-sg-note">{t("screening.saved")}</span> : null}
      {note === "failed" ? <span className="scn-sg-note">{t("screening.failed")}</span> : null}
    </div>
  );
}
