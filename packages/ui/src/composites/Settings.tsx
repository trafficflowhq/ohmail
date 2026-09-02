import type { ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import "./settings.css";

export interface SettingsSectionProps {
  children: ReactNode;
  className?: string;
}

/** A settings pane — lift-1 panel holding SettingsRows. */
export function SettingsSection({ children, className }: SettingsSectionProps) {
  return <div className={className ? `set-pane ${className}` : "set-pane"}>{children}</div>;
}

export interface SettingsSubheadProps {
  children: ReactNode;
}

/** Sub-heading inside a section ("VIP — always notifies"). */
export function SettingsSubhead({ children }: SettingsSubheadProps) {
  return <div className="set-sub">{children}</div>;
}

export interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Static right-aligned value ("English", "Connected"). */
  value?: ReactNode;
  /** Interactive control at the right (Switch, SegmentedControl, buttons). */
  control?: ReactNode;
  /** Leading decoration (tag dot). */
  leading?: ReactNode;
}

/** One settings row: label block left, value or control right. */
export function SettingsRow({ label, description, value, control, leading }: SettingsRowProps) {
  return (
    <div className="set-row">
      {leading}
      <div className="lab">
        <b>{label}</b>
        {description ? <span>{description}</span> : null}
      </div>
      {value !== undefined ? <span className="set-val">{value}</span> : null}
      {control}
    </div>
  );
}

export interface SettingsNoteProps {
  icon?: IconName;
  children: ReactNode;
}

/** The privacy/assurance note with its shield. */
export function SettingsNote({ icon = "shield", children }: SettingsNoteProps) {
  return (
    <p className="set-note">
      <Icon name={icon} />
      {children}
    </p>
  );
}

/* ═══ THE FORM GRAMMAR — the pieces a pane composes when a row is not enough ═══════════════
   `SettingsRow` is a fact or a switch. Everything below exists for the panes that ASK for
   something (a key, a password, a host), ANSWER a press (a connection test) or STATE a
   standing condition with its one verb (a mailbox organized elsewhere). Presentational only:
   no fetch, no copy of its own — the host brings the words, from the catalogue. */

export interface SettingsTitleProps {
  children: ReactNode;
}

/** The pane's subject, when the nav label needs a qualifier ("Cloud mailboxes"). */
export function SettingsTitle({ children }: SettingsTitleProps) {
  return <h2 className="set-title">{children}</h2>;
}

export interface SettingsLeadProps {
  children: ReactNode;
}

/** One sentence under the title — what this pane is about, in the mechanism's own words. */
export function SettingsLead({ children }: SettingsLeadProps) {
  return <p className="set-lead">{children}</p>;
}

export interface SettingsFieldProps {
  /** The `id` of the control, so the label reaches it. */
  htmlFor: string;
  label: ReactNode;
  /** The control — an `<input>`, `<select>` or `<textarea>`; or a `.set-field-row` with its verb. */
  children: ReactNode;
  /** The quiet line under the control. */
  hint?: ReactNode;
  className?: string;
}

/** Label above, control, hint below. Fields stack; wrap several in `.set-fields` for columns. */
export function SettingsField({ htmlFor, label, children, hint, className }: SettingsFieldProps) {
  return (
    <div className={className ? `set-field ${className}` : "set-field"}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <span className="set-field-hint">{hint}</span> : null}
    </div>
  );
}

export interface SettingsChoiceOption<T extends string = string> {
  id: T;
  label: ReactNode;
  /** The consequence of this option, one line. */
  description?: ReactNode;
  disabled?: boolean;
}

export interface SettingsChoiceProps<T extends string = string> {
  /** Shared by every radio in the group. */
  name: string;
  ariaLabel: string;
  options: SettingsChoiceOption<T>[];
  value: T;
  onChange: (id: T) => void;
  disabled?: boolean;
}

/**
 * A short list of exclusive options, each with its consequence — the control for a choice that
 * needs a sentence per option. A `SegmentedControl` is for up to four one-word options; the
 * AI provider ("None · your Anthropic key · …") wrapped its segments into nonsense at every
 * width, which is what this exists to replace. Real radios: ↑/↓ move, Space selects.
 */
export function SettingsChoice<T extends string = string>({
  name,
  ariaLabel,
  options,
  value,
  onChange,
  disabled,
}: SettingsChoiceProps<T>) {
  return (
    <div className="set-choice" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <label key={o.id}>
          <input
            type="radio"
            name={name}
            value={o.id}
            checked={o.id === value}
            disabled={disabled || o.disabled}
            onChange={() => onChange(o.id)}
          />
          <b>{o.label}</b>
          {o.description ? <span>{o.description}</span> : null}
        </label>
      ))}
    </div>
  );
}

/** The four things an answer can be. `off` = nothing has been asked yet. */
export type SettingsVerdictState = "ok" | "bad" | "wait" | "off";

export interface SettingsVerdictProps {
  state: SettingsVerdictState;
  /** The headline — what happened, in one clause ("The key works."). */
  headline: ReactNode;
  /** What the endpoint said — its own sentence, rendered whole. */
  detail?: ReactNode;
  /**
   * WHAT TO DO NEXT, as its OWN line rather than glued to {@link detail}.
   *
   * The two are written by different authors: `detail` is the endpoint's or the engine's sentence,
   * `hint` is ours. Concatenating them into one string means guessing whether the first ends
   * itself, and that guess cannot be made — a model identifier may legally end in `.`
   * (`ai-provider.ts:242` accepts it), so `does not have "foo."` is a stop belonging to a NAME and
   * `the server said "no such model."` is a stop belonging to a SENTENCE, and no regex separates
   * them. Three review rounds narrowed that guess and the fourth found the case that breaks it.
   * Two blocks need no separator at all.
   */
  hint?: ReactNode;
  /** "Checked 2 minutes ago" — the host formats it; absent while nothing has been asked. */
  when?: ReactNode;
}

/**
 * THE ANSWER TO A PRESS, under the press that asked — a connection test, a key test.
 *
 * It renders in place at every state, so a press changes the block on screen rather than a
 * line above the fold ("Test connection not showing any response" was exactly a verdict
 * rendered elsewhere). `role="status"` with a polite live region: a screen reader hears the
 * outcome without focus leaving the button. `wait` shows the sweep, never a bare "Testing…".
 */
export function SettingsVerdict({ state, headline, detail, hint, when }: SettingsVerdictProps) {
  const mark = state === "ok" ? "✓" : state === "bad" ? "✕" : "";
  return (
    <div className={`set-verdict ${state}`} role="status" aria-live="polite" aria-busy={state === "wait" || undefined}>
      <span className="set-verdict-mark" aria-hidden="true">{mark}</span>
      <b>{headline}</b>
      {detail ? <p>{detail}</p> : null}
      {hint ? <p className="set-verdict-hint">{hint}</p> : null}
      {when ? <span className="set-verdict-when">{when}</span> : null}
    </div>
  );
}

export interface SettingsActionsProps {
  children: ReactNode;
}

/** A form's verbs, primary first, in one place. */
export function SettingsActions({ children }: SettingsActionsProps) {
  return <div className="set-actions">{children}</div>;
}

export interface SettingsBannerProps {
  /** The standing fact ("Organized by ohmail Cloud"). */
  label: ReactNode;
  /** Since when, from where — the row's own words. */
  description?: ReactNode;
  /** The one verb, or nothing. */
  action?: ReactNode;
}

/** A standing condition about the pane's subject, with its one verb — the reader state. */
export function SettingsBanner({ label, description, action }: SettingsBannerProps) {
  return (
    <div className="set-banner" role="note">
      <div className="lab">
        <b>{label}</b>
        {description ? <span>{description}</span> : null}
      </div>
      {action}
    </div>
  );
}

export interface VipChipProps {
  children: ReactNode;
  /** Plays the accept pulse. */
  pulse?: boolean;
}

/** A VIP capsule with the accent dot. */
export function VipChip({ children, pulse }: VipChipProps) {
  return (
    <span className={pulse ? "vip pulse" : "vip"}>
      <span className="vdot" /> {children}
    </span>
  );
}
