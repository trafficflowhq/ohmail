"use client";

/**
 * "In your words, what belongs in your Ohbox" — the bar editor, once, for both tiers. The
 * account's sentence travels in the USER turn of the screening question as binding criteria,
 * asserted on the wire under both model providers by the engine's own end-to-end checks. Its own
 * file because two surfaces edit the same column and must not become two editors: the hosted client
 * reaches `PATCH /account/screening` over `app/api-client`, the standalone desktop reaches the SAME
 * route over the shell's pipe — the transport is a prop (`onSave`) and the rest lives here, which
 * also keeps the file compilable in both bundles: it names no client, no bridge, no route.
 */

/**
 * The prefill rule is the whole design: with no stored bar the box is PREFILLED with the product default as editable
 * text (tweak words you can see), Save stays inert until the text differs from the EFFECTIVE value, and clearing the
 * box saves `null` — "go back to the default", never "screen against an empty sentence". The prefill is in the
 * reader's language, and only the prefill: `defaultBar` is a SERVER constant (English, what filing runs were tested
 * against), so the box SHOWS `settings.screening.defaultBar` from the catalogue — display only; an untouched German
 * account still stores NULL and the model still receives the English constant (a drift guard holds the catalogue's
 * English byte-identical to the constant).
 */

/**
 * EITHER language's default counts as unchanged — under the narrow rule a German prefill differed from the English
 * constant on the first frame and one press converted a default account into a custom-bar account holding a sentence
 * no classifier run has seen. `onSave` answers with the bar actually stored, and that echo re-seeds the box; a failed
 * write leaves the words and shows one plain sentence.
 */

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button, TextField } from "@ohmail/ui";

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
      <TextField
        multiline
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
