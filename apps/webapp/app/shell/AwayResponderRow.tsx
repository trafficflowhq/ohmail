"use client";

/**
 * THE AWAY RESPONDER — the control for the one thing this product does that sends mail on its own.
 *
 * Until this existed the responder had a table, a REST endpoint and no surface: `PUT
 * /away-responder` was reachable only by hand, and nothing read what it stored. So this is the
 * whole of the configuration, deliberately small — the switch, what it says, and WHO gets it.
 *
 * ── WHY IT IS A FORM WITH A SAVE, AND NOT FOUR LIVE CONTROLS ─────────────────────────────────
 *
 * Every other control in Settings writes on the press: a switch flips, a dial moves, one field
 * changes. This one cannot, for a reason that is about the feature and not about the widget.
 *
 * `PUT /away-responder` is a FULL REPLACE, and the row's `updatedAt` is the away responder's
 * ENABLEMENT EPISODE — the key the worker's at-most-once record is filed under. So every write
 * starts a new episode and re-arms a reply to every correspondent already answered. A debounced
 * autosave on a text field would mint one episode per keystroke pause, and somebody fixing a typo
 * mid-holiday would answer their correspondents again, once per pause. One explicit press is one
 * episode, which is the honest number.
 *
 * ── THE AUDIENCE IS THE CONTROL THAT MATTERS, AND ITS DEFAULT IS THE NARROW ONE ──────────────
 *
 * "People I've let in" answers only senders already past the Screener. "Everyone who writes"
 * includes a first-contact stranger still waiting there — which tells them the address is live,
 * attended, and that its owner is somewhere else this week. That is a disclosure, so it is a choice
 * somebody makes rather than a default they inherit, and the copy says which is which without
 * scolding anybody for picking the wider one.
 *
 * The description under the switch says what the responder will NOT do, because that is the part
 * nobody can see: mailing lists, no-reply addresses, security mail and the account's own addresses
 * are never answered, and each correspondent is answered once. NONE OF THAT IS ENFORCED HERE — the
 * suppressions live in the server-side sender, and this component only reports them. So the copy
 * below is a claim about somebody else's code, which makes it the one thing in this file that can go
 * quietly false: if a guard is ever relaxed, this sentence has to be edited in the same change, and
 * a promise of protection may never be added here before the sender implements it.
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
  on: "On. One reply per person, from the mailbox they wrote to.",
  off: "Off. Nothing is sent.",
  subjectLabel: "Subject",
  bodyLabel: "Message",
  audienceLabel: "Who gets a reply",
  screenedIn: "People I've let in",
  everyone: "Everyone who writes",
  screenedInNote: "Senders still waiting in the Screener are not answered.",
  everyoneNote: "Strangers in the Screener are answered too — they learn this address is read.",
  never:
    "Never sent to mailing lists, no-reply addresses, security mail, or your own addresses. "
    + "Each person is answered once until you change these settings.",
  save: "Save",
  saving: "Saving…",
  saved: "Saved.",
  failed: "That did not save. Nothing changed.",
  incomplete: "Add a subject and a message before turning this on.",
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
 * `../api-client` to a stub whose every value export refuses. On the HOSTED door that window still
 * has an account behind it: the request goes down the pipe to the mail engine on this machine,
 * which serves no `/away-responder` locally and therefore forwards it to the account with the
 * bearer. Same endpoint, same stored row, same hosted sender — one hop more.
 *
 * So the transport is a parameter and everything else here is shared. A second copy of this control
 * for the desktop would be a second definition of what one enablement episode is, and the episode
 * is the key the worker's at-most-once record is filed under.
 */
export interface AwayTransport {
  state: () => Promise<AwayResponderWire>;
  save: (next: Omit<AwayResponderWire, "updatedAt">) => Promise<AwayResponderWire>;
}

/** The two audiences, in the order the control draws them. Labels are resolved at render. */
const AUDIENCE_IDS: readonly Audience[] = ["screened_in", "everyone"];

type Draft = Omit<AwayResponderWire, "updatedAt">;

const RESTING: Draft = {
  enabled: false, subject: null, body: null, startsAt: null, endsAt: null, audience: "screened_in",
};

export function AwayResponderRow({ onChanged, transport }: {
  /**
   * THE SHELL'S ECHO — how the Ohbox notice (`AwayNotice.tsx`) learns of a same-tab edit
   * without a refetch. Called with what the SERVER answered — the mount load and every save
   * echo, never what a click asked for — so the row and any listener can only agree.
   * Optional: this row predates the notice, and a mount with nothing to tell stays valid.
   */
  onChanged?: (state: { enabled: boolean; audience: Audience }) => void;
  /** The two calls, or the hosted client. See {@link AwayTransport}. */
  transport?: AwayTransport;
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
          enabled: loaded.enabled, subject: loaded.subject, body: loaded.body,
          startsAt: loaded.startsAt, endsAt: loaded.endsAt, audience: loaded.audience,
        });
        changed.current?.({ enabled: loaded.enabled, audience: loaded.audience });
      } catch {
        // No server, or a refused read. The CONTROLS stay absent rather than offering one whose
        // Save would fail — a responder somebody believes they configured is worse than none — and
        // the pane says so instead of drawing nothing. See {@link unreachable}.
        if (alive.current) { setDraft(null); setUnreachable(true); }
      }
    })();
  }, []);

  if (!draft) return unreachable ? <p className="set-note-inline">{t("unreachable")}</p> : null;

  const complete = (draft.subject ?? "").trim().length > 0 && (draft.body ?? "").trim().length > 0;
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
          enabled: stored.enabled, subject: stored.subject, body: stored.body,
          startsAt: stored.startsAt, endsAt: stored.endsAt, audience: stored.audience,
        });
        changed.current?.({ enabled: stored.enabled, audience: stored.audience });
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
      {/* THE TWO THINGS SOMEBODY WRITES ARE FIELDS, NOT ROWS. `SettingsRow` puts its control at
          the right of a label, which is right for a switch and wrong for prose: the subject line
          got a 200px flex basis and the message a three-row textarea in the same gutter, so the
          one control in Settings whose content is a sentence people will read was the narrowest
          one on the pane. `SettingsField` is label above, control at full width, hint below —
          and its `htmlFor` gives each control a VISIBLE accessible name, which is what the
          `aria-label` here was standing in for. */}
      <SettingsField htmlFor="away-subject" label={t("subjectLabel")}>
        <input
          id="away-subject"
          type="text"
          value={draft.subject ?? ""}
          disabled={pending}
          onChange={(e) => edit({ subject: e.target.value })}
        />
      </SettingsField>
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
      <p className="set-note-inline">{t("never")}</p>
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
