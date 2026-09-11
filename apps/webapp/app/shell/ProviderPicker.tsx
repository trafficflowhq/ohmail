"use client";

/**
 * The provider picker — the ONE control behind every "connect a mailbox" surface (first-run,
 * Settings → Mailboxes, the desktop's local door): the two bare `<select>`s it replaced drifted
 * twice. The seven named providers render as a radiogroup of tiles; the generic "any IMAP" entry
 * is a different kind of answer and renders as its own recessed row. NO brand logos: hotlinked
 * marks are forbidden (zero off-origin loads) and self-drawn imitations of trademarks are
 * liability with no upside. Selection reveals the provider's `note` — the sentence that stops
 * someone typing their ACCOUNT password into a third-party form — carried via `aria-describedby`;
 * only `manual` reveals host fields, which stay with the callers. A radiogroup with roving
 * tabindex: arrows move focus AND selection (per the APG radio pattern), Enter/Space select.
 */

import { useId, useRef } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@ohmail/ui";
import { PROVIDERS, providerById, providerLabel, type ProviderPreset } from "./providers";

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
  const tiles = useRef<Array<HTMLButtonElement | null>>([]);

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
        aria-describedby={on ? noteId : undefined}
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
      {selected ? (
        // Keyed by provider so switching re-runs the rise — the panel visibly answers
        // the click rather than silently swapping its text.
        <div className="pvp-note" id={noteId} key={selected.id}>
          <p>{note ?? selected.note}</p>
          {showHelp && selected.helpUrl ? (
            <a href={selected.helpUrl} target="_blank" rel="noreferrer noopener">
              {selected.helpLabel}
              <Icon name="open" size={11} />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
