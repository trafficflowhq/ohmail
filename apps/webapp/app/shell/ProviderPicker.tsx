"use client";

/**
 * The provider picker — the ONE control behind every "connect a mailbox" surface (first-run,
 * Settings → Mailboxes, the desktop's local door): the two bare `<select>`s it replaced drifted
 * twice. The named providers render as a radiogroup of tiles; the generic "any IMAP" entry
 * is a different kind of answer and renders as its own recessed row. Proton is a tile outside the
 * group: a note behind a button, never a choice, because ohmail cannot connect to it. NO brand
 * logos: hotlinked marks are forbidden (zero off-origin loads), self-drawn trademark imitations are
 * liability.
 * Selection reveals the provider's `note` — the sentence that stops someone typing their ACCOUNT
 * password into a third-party form — via `aria-describedby`; only `manual` reveals host fields. A
 * radiogroup with roving tabindex: arrows move focus AND selection (APG), Enter/Space select.
 */

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@ohmail/ui";
import { PROTON, PROVIDERS, providerById, providerLabel, type ProviderPreset } from "./providers";

const NAMED: ProviderPreset[] = PROVIDERS.filter((p) => !p.manual);
const MANUAL: ProviderPreset = PROVIDERS.find((p) => p.manual)!;
/** Focus/arrow order: the grid left-to-right, then the manual row. */
const ORDER: ProviderPreset[] = [...NAMED, MANUAL];

export function ProviderPicker({ value, onChange, note, showHelp = true }: {
  /** The selected provider id, or `null` while nothing is chosen yet. */
  value: string | null;
  onChange: (id: string) => void;
  /**
   * Override the selected provider's own `note`. The preset note is written for the app-password
   * path; a caller that connects the SAME provider a different way (Microsoft by sign-in, when the
   * deployment's Entra door is armed) would otherwise render a false instruction, so it passes the
   * sentence that path actually needs. Undefined ⇒ the preset note, unchanged for every caller that
   * does not pass it.
   */
  note?: string;
  /**
   * Whether to show the preset's help link. That link points at the provider's app-password docs;
   * on a path that uses no app password it is a wrong turn, so the caller drops it. Defaults true.
   */
  showHelp?: boolean;
}) {
  const t = useTranslations("providerPicker");
  const labelId = useId();
  const noteId = useId();
  const protonId = useId();
  const tiles = useRef<Array<HTMLButtonElement | null>>([]);
  // Proton's note is open: it stands in for the chosen provider's until a provider is chosen.
  const [proton, setProton] = useState(false);
  useEffect(() => { setProton(false); }, [value]);

  // `providerById` answers the manual entry for an unknown id — the same fallback the
  // callers rely on, so a stale or bogus id can never highlight a wrong named preset.
  const selected = value ? providerById(value) : null;
  const at = selected ? ORDER.findIndex((p) => p.id === selected.id) : -1;

  /**
   * A choice that did not change is not a choice, and reporting it as one loses data. Every
   * consumer answers `onChange` by writing the chosen preset's hosts into its form, and the generic
   * entry's hosts are the empty string — so re-notifying the SAME id blanked the IMAP and SMTP
   * hosts somebody had typed. An easy accidental gesture: the checked tile is the roving tab stop,
   * and after a failed submit the error banner invites one confirming click on the provider already
   * chosen. `hostsFor` makes that write harmless from the other side; this makes the event honest.
   * Focus still moves unconditionally — the roving tabindex is about where you ARE.
   */
  const choose = (id: string): void => {
    setProton(false);
    if (id !== selected?.id) onChange(id);
  };

  const moveTo = (index: number): void => {
    choose(ORDER[index]!.id);
    tiles.current[index]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const last = ORDER.length - 1;
    // A key this group handles STOPS here. The registry's document listener now binds the
    // arrows too (the zone walk, `zone-nav.tsx`), and the tiles sit inside a settings pane —
    // without the stop, one press would both move the radio selection and scroll the pane.
    // `stopImmediatePropagation` ON THE NATIVE EVENT, not only `stopPropagation`: the App
    // Router hydrates the whole document, so React and the registry are sibling listeners on
    // the SAME node, and stopping propagation cannot stop a sibling — MoreMenu measured this
    // on the deployed build. Unhandled keys fall through untouched.
    const handled = (): void => {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
    };
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        handled();
        moveTo(at < 0 || at >= last ? 0 : at + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        handled();
        moveTo(at <= 0 ? last : at - 1);
        break;
      case "Home":
        handled();
        moveTo(0);
        break;
      case "End":
        handled();
        moveTo(last);
        break;
    }
  };

  const tile = (p: ProviderPreset, index: number) => {
    const on = selected?.id === p.id;
    return (
      <button
        key={p.id}
        ref={(el) => { tiles.current[index] = el; }}
        type="button"
        role="radio"
        aria-checked={on}
        aria-describedby={on && !proton ? noteId : undefined}
        // Roving tabindex: the checked tile is the group's tab stop; before any choice,
        // the first tile is, so the group is always enterable with one Tab.
        tabIndex={on || (at < 0 && index === 0) ? 0 : -1}
        className={p.manual ? "pvp-tile pvp-other" : "pvp-tile"}
        onClick={() => choose(p.id)}
      >
        <span className="pvp-name">{providerLabel(p, t)}</span>
        <span className="pvp-host">{p.manual ? t("otherSub") : p.imap.host}</span>
        {on ? <Icon name="check" className="pvp-check" size={12} /> : null}
      </button>
    );
  };

  return (
    <div className="pvp">
      <span className="join-label" id={labelId}>{t("label")}</span>
      <div role="radiogroup" aria-labelledby={labelId} onKeyDown={onKeyDown}>
        {/* The generic entry is IN the grid, as a box like every other. It shipped as a
            full-width recessed row and read as a leftover rather than a choice — "list other
            IMAP also as a box of course, otherwise it looks weird" (owner). It keeps a
            quieter treatment (`.pvp-other`) because it IS a different kind of answer, but a
            quieter tile is still a tile. */}
        <div className="pvp-grid">
          {NAMED.map((p, i) => tile(p, i))}
          {tile(MANUAL, NAMED.length)}
        </div>
      </div>
      <div className="pvp-grid pvp-aside">
        <button
          type="button"
          className="pvp-tile pvp-other"
          aria-expanded={proton}
          aria-controls={proton ? protonId : undefined}
          onClick={() => setProton((open) => !open)}
        >
          <span className="pvp-name">{PROTON.label}</span>
          <span className="pvp-host">{t("protonSub")}</span>
        </button>
      </div>
      {proton ? (
        <div key="proton" className="pvp-note" id={protonId}>
          <p>{t("protonNote", { other: t("otherLabel") })}</p>
        </div>
      ) : selected ? (
        // Keyed by provider so switching re-runs the rise — the panel visibly answers
        // the click rather than silently swapping its text.
        <ProviderNote key={selected.id} preset={selected} id={noteId} note={note} showHelp={showHelp} />
      ) : null}
    </div>
  );
}

/**
 * THE PRESET'S NOTE, on its own: what to fetch from the provider before typing a password. Drawn by the
 * picker and by every surface that shows a chosen provider without it (FirstRun's guided choice), so a
 * Gmail user reads "App Password, not your Google password" before the first press wherever they are.
 * The preset's note and links in the screen's language: the catalogue's `note_<id>`, `help_<id>` and
 * `prereq_<id>`, whose English is held equal to the engine table's.
 */
export function ProviderNote({ preset, id, note, showHelp = true }: {
  preset: ProviderPreset;
  id?: string;
  /** See {@link ProviderPicker}'s `note`. */
  note?: string;
  /** See {@link ProviderPicker}'s `showHelp`; also drops the prerequisite link. */
  showHelp?: boolean;
}) {
  const t = useTranslations("providerPicker");
  return (
    <div className="pvp-note" id={id}>
      <p>{note ?? t(`note_${preset.id}` as Parameters<typeof t>[0])}</p>
      {showHelp ? <ProviderHelpLinks preset={preset} /> : null}
    </div>
  );
}

/**
 * The preset's own links — its prerequisite first (Google: 2-Step Verification), then its App
 * Passwords page — as anchors, opened only by the person's own click. Phrasing content, so it sits in
 * a refusal's hint line as well as in the note. Nothing for a preset with neither.
 */
export function ProviderHelpLinks({ preset }: { preset: ProviderPreset }) {
  const t = useTranslations("providerPicker");
  if (!preset.helpUrl && !preset.prereqUrl) return null;
  return (
    <span className="pvp-links">
      {preset.prereqUrl ? (
        <a href={preset.prereqUrl} target="_blank" rel="noreferrer noopener">
          {t(`prereq_${preset.id}` as Parameters<typeof t>[0])}
          <Icon name="open" size={11} />
        </a>
      ) : null}
      {preset.helpUrl ? (
        <a href={preset.helpUrl} target="_blank" rel="noreferrer noopener">
          {t(`help_${preset.id}` as Parameters<typeof t>[0])}
          <Icon name="open" size={11} />
        </a>
      ) : null}
    </span>
  );
}
