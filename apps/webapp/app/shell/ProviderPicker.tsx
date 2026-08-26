"use client";

/**
 * The provider picker — the ONE control behind every "connect a mailbox" surface: the hosted
 * client's first-run mailbox step, its Settings → Mailboxes pane, and the desktop app's local
 * door. One component, deliberately: the two bare `<select>`s it replaced were written twice
 * and drifted twice, and a third surface is where that happens again.
 *
 * ── THE SHAPE ────────────────────────────────────────────────────────────────────────────
 *
 * Choosing the provider is the primary act of the screen this sits on, so the seven named
 * providers render as a radiogroup of shadow-lifted tiles — a choice between recognisable
 * things, not a form field. The generic "any IMAP" entry is a different kind of answer
 * ("none of these") and renders as its own recessed full-width row under the grid rather
 * than an eighth equal tile.
 *
 * NO BRAND LOGOS, deliberately. Hotlinked marks are forbidden outright — every surface this
 * renders on asserts zero off-origin loads — and self-drawn monochrome
 * imitations of trademarked marks are a liability with no upside: the provider NAME is what
 * people recognise, and the IMAP host under it is the factual line that says what will
 * actually be configured. Blanc: type, not badges.
 *
 * Selection reveals the provider's `note` — the sentence that stops someone typing their
 * ACCOUNT password into a third-party form — plus its help link. That panel is the point of
 * the control, not an afterthought: it renders accent-soft directly under the choice, and
 * the selected tile carries it via `aria-describedby` so a screen reader hears it with the
 * radio. Only the `manual` entry reveals host fields, and those stay with the callers (the
 * host values are caller state that must survive each caller's own submit/ceremony flow).
 *
 * ── KEYBOARD ─────────────────────────────────────────────────────────────────────────────
 *
 * A radiogroup with roving tabindex. Arrows move focus AND selection (selection is cheap
 * and reversible, so selection-follows-focus, per the APG radio pattern); Home/End jump to
 * the ends; Enter/Space select the focused tile via native button activation (`type=
 * "button"`, so Enter never submits the surrounding form).
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

  const moveTo = (index: number): void => {
    onChange(ORDER[index]!.id);
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
        onClick={() => onChange(p.id)}
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
