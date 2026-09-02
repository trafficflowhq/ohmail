"use client";

/**
 * THE AWAY RESPONDER — the control for the one thing this product does that sends mail on its own.
 *
 * Until this existed the responder had a table, a REST endpoint and no surface: `PUT
 * /away-responder` was reachable only by hand, and nothing read what it stored. So this is the
 * whole of the configuration, deliberately small — the switch, what it says, and WHO gets it.
 *
 * ── WHY IT IS A FORM WITH A SAVE, AND NOT FIVE LIVE CONTROLS ─────────────────────────────────
 *
 * Every other control in Settings writes on the press: a switch flips, a dial moves, one field
 * changes. This one does not, and the ORIGINAL reason has since been engineered away — which is
 * worth recording, because it is no longer the reason.
 *
 * It used to be that `updatedAt` was the responder's "enablement episode", the key the at-most-once
 * record was filed under, so every save re-armed a reply to every correspondent already answered
 * and a debounced autosave would have minted one episode per keystroke pause. That is fixed rather
 * than mitigated: the window's floor is `enabled_at`, which moves only on OFF → ON, and
 * `throttle='per_message'` is keyed by a HASH OF THE TEXT. Saving without editing now changes
 * nothing about who gets answered.
 *
 * The form stays a form for a plainer reason: `PUT /away-responder` is a FULL REPLACE, and the
 * message is prose. A live-saving textarea would write a half-typed sentence into mail that goes
 * out in somebody's name while they are not looking. One explicit press is one decision about what
 * strangers will read.
 *
 * ── THE AUDIENCE IS THE CONTROL THAT MATTERS, AND ITS DEFAULT IS THE NARROW ONE ──────────────
 *
 * "People I've let in" answers only senders already past the Screener. "Everyone who writes"
 * includes a first-contact stranger still waiting there — which tells them the address is live,
 * attended, and that its owner is somewhere else this week. That is a disclosure, so it is a choice
 * somebody makes rather than a default they inherit, and the copy says which is which without
 * scolding anybody for picking the wider one.
 *
 * ── AND THE RATE IS THE CONTROL THAT WAS MISSING ─────────────────────────────────────────────
 *
 * "Each person is answered once per enablement" used to be a consequence of the schema that nobody
 * had chosen and nobody could change. It is a setting now — every message, once per text, once a
 * day (the default), once a week — because the right answer differs by why somebody is away: a day
 * out of the office and a month on sabbatical are not the same promise to make to a correspondent
 * who writes every morning.
 *
 * The description under the switch says what the responder will NOT do, because that is the part
 * nobody can see: mailing lists, no-reply addresses, security mail, senders screened out, and the
 * account's own addresses are never answered. NONE OF THAT IS ENFORCED HERE — the suppressions are
 * `packages/core/src/away-eligibility.ts`'s and this component only reports them. So the copy below
 * is a claim about somebody else's code, which makes it the one thing in this file that can go
 * quietly false: if a guard is ever relaxed, this sentence has to be edited in the same change, and
 * a promise of protection may never be added here before the guard exists.
 *
 * ── COPY IS A SHIM, ON PURPOSE ───────────────────────────────────────────────────────────────
 *
 * Its copy lives in the `away` namespace of `messages/en.json`, like every other user-visible
 * string in this app. It used to be a local `COPY` constant — "a deliberate, temporary shim so the
 * control can ship in one slice" — and the German translation is what came to collect it: a shim is
 * a surface the catalogue cannot reach, so it is a surface that stays English for ever.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SegmentedControl, SettingsActions, SettingsField, SettingsRow, Switch } from "@ohmail/ui";
import { away as awayApi, type AwayResponderWire } from "../api-client";

/**
 * THE ENGLISH SENTENCES, KEPT — as the shape of the `away` namespace and nothing more.
 *
 * Not read at render: every string on screen comes from `t(...)` below. It stays because
 * `test/locale-shim-parity.test.ts` holds it against `en.json` key for key and text for text, which
 * is what makes "the catalogue says exactly what this control says" a checked claim rather than a
 * migration somebody eyeballed once. Deleting it deletes the check.
 */
export const AWAY_COPY = {
  title: "Away responder",
  on: "On. Replies to new mail, from the mailbox it arrived in.",
  off: "Off. Nothing is sent.",
  bodyLabel: "Message",
  audienceLabel: "Who gets a reply",
  screenedIn: "People I've let in",
  everyone: "Everyone who writes",
  screenedInNote: "Senders still waiting in the Screener are not answered.",
  everyoneNote: "Strangers in the Screener are answered too — they learn this address is read.",
  throttleLabel: "How often per person",
  always: "Every message",
  per_message: "Once, until you change the text",
  per_day: "At most once a day",
  per_week: "At most once a week",
  never:
    "Never sent to mailing lists, no-reply addresses, security mail, senders you've screened out, "
    + "or your own addresses.",
  localNote: "Replies are sent while ohmail is open on this computer.",
  save: "Save",
  saving: "Saving…",
  saved: "Saved.",
  failed: "That did not save. Nothing changed.",
  incomplete: "Add a message before turning this on.",
  unreachable: "Your away settings could not be read just now. Nothing here has changed.",
} as const;

type Audience = AwayResponderWire["audience"];

/**
 * WHERE THE ROW IS READ AND WRITTEN — the two calls, as a seam, because two installs reach the
 * same account's row down two different wires.
 *
 * A BROWSER TAB opens a socket to the hosted API, which is exactly what `app/api-client`'s `away`
 * is, and that stays the default so no caller in this app has to say so.
 *
 * THE DESKTOP CANNOT. Its content policy forbids the window opening a socket at all, and the Cloud
 * client is not compiled into that build — `apps/desktop/vite.config.ts` aliases this module's
 * `../api-client` to a stub whose every value export refuses. Both of its doors therefore send the
 * request down the pipe to the mail engine on this machine, and what the engine does with it
 * differs: on the HOSTED door it forwards to the account with the bearer, so the row is the hosted
 * account's; on the STANDALONE door it answers out of the database on this machine, and the drain
 * in that same engine is what sends. Same endpoint, same fields, same control — see {@link local}
 * for the one sentence that differs.
 *
 * So the transport is a parameter and everything else here is shared. A second copy of this control
 * for the desktop would be a second definition of what the responder stores and what its copy
 * promises, on the one surface in the product that decides what strangers are told.
 */
export interface AwayTransport {
  state: () => Promise<AwayResponderWire>;
  save: (next: Omit<AwayResponderWire, "updatedAt">) => Promise<AwayResponderWire>;
}

/** The two audiences, in the order the control draws them. Labels are resolved at render. */
const AUDIENCE_IDS: readonly Audience[] = ["screened_in", "everyone"];

type Throttle = AwayResponderWire["throttle"];

/**
 * The four rates, LOOSEST FIRST, which is the order the sentence they form reads in: every message,
 * then once per text, then a day, then a week. `per_day` is the default and sits third rather than
 * first on purpose — the control shows where the default sits on a range, instead of presenting it
 * as the leading option and the rest as departures from it.
 */
const THROTTLE_IDS: readonly Throttle[] = ["always", "per_message", "per_day", "per_week"];

type Draft = Omit<AwayResponderWire, "updatedAt">;

const RESTING: Draft = {
  enabled: false, body: null, startsAt: null, endsAt: null,
  audience: "screened_in", throttle: "per_day",
};

export function AwayResponderRow({ onChanged, transport, local = false }: {
  /**
   * THE SHELL'S ECHO — how the Ohbox notice (`AwayNotice.tsx`) learns of a same-tab edit
   * without a refetch. Called with what the SERVER answered — the mount load and every save
   * echo, never what a click asked for — so the row and any listener can only agree.
   * Optional: this row predates the notice, and a mount with nothing to tell stays valid.
   */
  onChanged?: (state: { enabled: boolean; audience: Audience; throttle: Throttle }) => void;
  /** The two calls, or the hosted client. See {@link AwayTransport}. */
  transport?: AwayTransport;
  /**
   * IS THIS THE STANDALONE DOOR? — decides one sentence, and only that.
   *
   * On a standalone install the replies are sent by the engine on THIS machine, which runs only
   * while the window is open. The control is otherwise identical (same row, same endpoint shape,
   * same stored fields), so this is a note and not a mode — but it is a note the pane may not omit:
   * offering a responder that silently does nothing overnight, under copy written for a door that
   * never sleeps, is the control lying about what it does.
   *
   * Defaults to false, which is the HOSTED reading, and that default is safe in the direction that
   * matters: a hosted pane that wrongly showed the note would understate a promise it does keep,
   * and the caller that would have to get it wrong (`DesktopGate`) reads it from `awayDoorFor`.
   */
  local?: boolean;
} = {}) {
  const t = useTranslations("away");
  /**
   * `null` until the server has answered. The controls are not drawn before then, for the reason
   * `RemoteImagesRow` gives about its own switch and more sharply: drawing the resting OFF state to
   * somebody whose responder is ON, who then leaves the pane, would show them a responder that is
   * not sending while it is.
   */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<"idle" | "saved" | "failed">("idle");
  /**
   * THE READ CAME BACK REFUSED — and this is a state rather than silence BECAUSE THE CONTROL HAS
   * ITS OWN PANE NOW.
   *
   * As the last row of the Screener pane, a failed load could render nothing: the four controls
   * above it still filled the screen, and an absent row was the honest "no configuration to show".
   * On its own pane, nothing means a nav entry that opens a blank rectangle — which reads as an
   * app that lost something. So the pane says which of the two it is. It still never draws the
   * CONTROLS on a failed read, for the reason the load effect gives: a resting OFF switch shown to
   * somebody whose responder is ON is a lie about mail going out.
   */
  const [unreachable, setUnreachable] = useState(false);

  /** The echo through a ref, so the load effect below keeps its once-per-mount `[]` deps. */
  const changed = useRef(onChanged);
  changed.current = onChanged;

  /** The host's transport through a ref, for the reason the echo is: one load, at mount. */
  const wired = useRef(transport);
  wired.current = transport;

  /**
   * A HOST'S WIRE, OR THE HOSTED CLIENT — resolved at the CALL and never at the render.
   *
   * `??` would read `awayApi` on every render of a row that has a transport and will never touch
   * it, and that read is not free: on a standalone install this binding is a stub whose properties
   * refuse, and a suite that mocks `../api-client` throws on the read itself. Both calls below are
   * inside a `try`, so resolving here keeps a refusal a state this component can draw rather than a
   * render that dies.
   */
  const wireOf = (): AwayTransport => wired.current ?? awayApi;

  /** Unmounted-after-await guard — a nav press swaps this pane out mid-request. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await wireOf().state();
        if (!alive.current) return;
        setDraft({
          enabled: loaded.enabled, body: loaded.body,
          startsAt: loaded.startsAt, endsAt: loaded.endsAt,
          audience: loaded.audience, throttle: loaded.throttle,
        });
        changed.current?.({ enabled: loaded.enabled, audience: loaded.audience, throttle: loaded.throttle });
      } catch {
        // No server, or a refused read. The CONTROLS stay absent rather than offering one whose
        // Save would fail — a responder somebody believes they configured is worse than none — and
        // the pane says so instead of drawing nothing. See {@link unreachable}.
        if (alive.current) { setDraft(null); setUnreachable(true); }
      }
    })();
  }, []);

  if (!draft) return unreachable ? <p className="set-note-inline">{t("unreachable")}</p> : null;

  // The MESSAGE alone now: the responder composes no subject of its own, so the only thing that
  // can be missing is the words. The server holds the same line (`liveResponders` skips a responder
  // with an empty body), and this is that requirement stated where somebody can see why.
  const complete = (draft.body ?? "").trim().length > 0;
  const edit = (patch: Partial<Draft>): void => {
    setState("idle");
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  const save = (): void => {
    if (pending || !draft) return;
    // The worker refuses to compose, so an enabled responder with nothing written in it would be
    // stored and then do nothing at all. Refused here too, where somebody can see why.
    if (draft.enabled && !complete) { setState("failed"); return; }
    setPending(true);
    setState("idle");
    void (async () => {
      try {
        const stored = await wireOf().save(draft);
        if (!alive.current) return;
        // Set from the ECHO, never from what was asked for: the server is what the worker reads.
        setDraft({
          enabled: stored.enabled, body: stored.body,
          startsAt: stored.startsAt, endsAt: stored.endsAt,
          audience: stored.audience, throttle: stored.throttle,
        });
        changed.current?.({ enabled: stored.enabled, audience: stored.audience, throttle: stored.throttle });
        setState("saved");
      } catch {
        if (alive.current) setState("failed");
      } finally {
        if (alive.current) setPending(false);
      }
    })();
  };

  return (
    <>
      <SettingsRow
        label={t("title")}
        description={draft.enabled ? t("on") : t("off")}
        control={
          <Switch
            checked={draft.enabled}
            disabled={pending}
            ariaLabel={t("title")}
            onChange={(enabled) => edit({ enabled })}
          />
        }
      />
      {/* THE ONE THING SOMEBODY WRITES IS A FIELD, NOT A ROW. `SettingsRow` puts its control at
          the right of a label, which is right for a switch and wrong for prose: the message got a
          three-row textarea in a narrow gutter, so the one control in Settings whose content is a
          sentence people will read was the narrowest one on the pane. `SettingsField` is label
          above, control at full width, hint below — and its `htmlFor` gives the control a VISIBLE
          accessible name, which is what the `aria-label` here was standing in for.

          The SUBJECT field that stood above this one is gone: the responder replies in the
          correspondent's own thread under `Re: <their subject>`, so there is nothing to compose. */}
      <SettingsField htmlFor="away-body" label={t("bodyLabel")}>
        <textarea
          id="away-body"
          rows={4}
          value={draft.body ?? ""}
          disabled={pending}
          onChange={(e) => edit({ body: e.target.value })}
        />
      </SettingsField>
      <SettingsRow
        label={t("audienceLabel")}
        description={draft.audience === "everyone" ? t("everyoneNote") : t("screenedInNote")}
        control={
          <SegmentedControl<Audience>
            options={AUDIENCE_IDS.map((id) => ({ id, label: t(id === "everyone" ? "everyone" : "screenedIn") }))}
            value={draft.audience}
            ariaLabel={t("audienceLabel")}
            onChange={(audience) => edit({ audience })}
          />
        }
      />
      {/* THE RATE. `SegmentedControl` because the four members are one ordered range and somebody
          choosing between them is choosing a POSITION on it — a select would hide three of the four
          behind a press and lose that. Same widget as the audience row above, so the two settings
          that decide who hears from this address and how often read as one pair.

          A designer pass may restyle this; the shape is the existing control, not a new one. */}
      <SettingsRow
        label={t("throttleLabel")}
        control={
          <SegmentedControl<Throttle>
            options={THROTTLE_IDS.map((id) => ({ id, label: t(id) }))}
            value={draft.throttle}
            ariaLabel={t("throttleLabel")}
            onChange={(throttle) => edit({ throttle })}
          />
        }
      />
      {/* WHAT THE RESPONDER WILL NOT DO — the part nobody can see, and therefore the part that has
          to be said. NONE OF IT IS ENFORCED HERE: the suppressions live in
          `packages/core/src/away-eligibility.ts` and this sentence only reports them, which makes
          it a claim about somebody else's code. If a guard is ever relaxed, this line is edited in
          the same change, and a promise of protection may never be added here before the guard
          exists. `screened out` was added to it in the same commit that made
          `AWAY_NEVER_ANSWERED_FOLDERS` audience-blind.

          The per-person rate is deliberately NOT restated here: it is the control directly above,
          and a sentence repeating it would go stale the moment the two disagree. */}
      <p className="set-note-inline">{t("never")}</p>
      {/* THE STANDALONE PROMISE, and it is only true on that door. An install with no account
          behind it answers mail from THIS machine while the window is open, so "your responder is
          on" would be a promise the app cannot keep overnight. The hosted door keeps it, and says
          nothing extra. `localNote` is rendered on the strength of the transport the host passed,
          not on a guess about the environment — see `AwayTransport`. */}
      {local ? <p className="set-note-inline">{t("localNote")}</p> : null}
      {/* THE VERB AND ITS ANSWER, TOGETHER. The outcome used to render as a bare `<span>` after a
          `gate-actions` div — the sign-in gate's container, borrowed on a settings pane — so the
          one press in Settings that starts an enablement episode reported into loose text below
          itself. `SettingsActions` is the form-verb row this pane's other forms use, and the
          outcome sits in it, beside the button that asked. Both are live regions: this is the
          only control here that sends mail, so whether the press took has to reach somebody who
          is not watching the pixels. */}
      <SettingsActions>
        <Button variant="primary" onClick={save} disabled={pending}>
          {pending ? t("saving") : t("save")}
        </Button>
        {state === "saved" ? (
          <span className="set-note-inline" role="status">{t("saved")}</span>
        ) : null}
        {state === "failed" ? (
          <span className="set-note-inline" role="alert">{complete ? t("failed") : t("incomplete")}</span>
        ) : null}
      </SettingsActions>
    </>
  );
}
