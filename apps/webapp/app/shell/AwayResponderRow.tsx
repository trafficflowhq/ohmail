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
 * The strings are literals in {@link COPY} rather than `settings` keys in `messages/en.json`.
 * This is a deliberate, temporary shim so the control can ship in one slice: one object, one place,
 * ready to be lifted into the message catalogue by whoever does the i18n pass. Nothing else in this
 * file contains a user-visible string.
 */

import { useEffect, useRef, useState } from "react";
import { Button, SegmentedControl, SettingsRow, Switch } from "@ohmail/ui";
import { away as awayApi, type AwayResponderWire } from "../api-client";

/** THE COPY SHIM. One object, so the i18n pass has one thing to move. */
const COPY = {
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
} as const;

type Audience = AwayResponderWire["audience"];

const AUDIENCES: Array<{ id: Audience; label: string }> = [
  { id: "screened_in", label: COPY.screenedIn },
  { id: "everyone", label: COPY.everyone },
];

type Draft = Omit<AwayResponderWire, "updatedAt">;

const RESTING: Draft = {
  enabled: false, subject: null, body: null, startsAt: null, endsAt: null, audience: "screened_in",
};

export function AwayResponderRow({ onChanged }: {
  /**
   * THE SHELL'S ECHO — how the Ohbox notice (`AwayNotice.tsx`) learns of a same-tab edit
   * without a refetch. Called with what the SERVER answered — the mount load and every save
   * echo, never what a click asked for — so the row and any listener can only agree.
   * Optional: this row predates the notice, and a mount with nothing to tell stays valid.
   */
  onChanged?: (state: { enabled: boolean; audience: Audience }) => void;
} = {}) {
  /**
   * `null` until the server has answered. The controls are not drawn before then, for the reason
   * `RemoteImagesRow` gives about its own switch and more sharply: drawing the resting OFF state to
   * somebody whose responder is ON, who then leaves the pane, would show them a responder that is
   * not sending while it is.
   */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<"idle" | "saved" | "failed">("idle");

  /** The echo through a ref, so the load effect below keeps its once-per-mount `[]` deps. */
  const changed = useRef(onChanged);
  changed.current = onChanged;

  /** Unmounted-after-await guard — a nav press swaps this pane out mid-request. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const wire = await awayApi.state();
        if (!alive.current) return;
        setDraft({
          enabled: wire.enabled, subject: wire.subject, body: wire.body,
          startsAt: wire.startsAt, endsAt: wire.endsAt, audience: wire.audience,
        });
        changed.current?.({ enabled: wire.enabled, audience: wire.audience });
      } catch {
        // No server, or a refused read. The section stays absent rather than offering a control
        // whose Save would fail — a responder somebody believes they configured is worse than none.
        if (alive.current) setDraft(null);
      }
    })();
  }, []);

  if (!draft) return null;

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
        const wire = await awayApi.save(draft);
        if (!alive.current) return;
        // Set from the ECHO, never from what was asked for: the server is what the worker reads.
        setDraft({
          enabled: wire.enabled, subject: wire.subject, body: wire.body,
          startsAt: wire.startsAt, endsAt: wire.endsAt, audience: wire.audience,
        });
        changed.current?.({ enabled: wire.enabled, audience: wire.audience });
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
        label={COPY.title}
        description={draft.enabled ? COPY.on : COPY.off}
        control={
          <Switch
            checked={draft.enabled}
            disabled={pending}
            ariaLabel={COPY.title}
            onChange={(enabled) => edit({ enabled })}
          />
        }
      />
      <SettingsRow
        label={COPY.subjectLabel}
        control={
          <input
            className="join-input set-tag-input"
            type="text"
            value={draft.subject ?? ""}
            disabled={pending}
            aria-label={COPY.subjectLabel}
            onChange={(e) => edit({ subject: e.target.value })}
          />
        }
      />
      <SettingsRow
        label={COPY.bodyLabel}
        control={
          <textarea
            className="set-screening-textarea"
            rows={3}
            value={draft.body ?? ""}
            disabled={pending}
            aria-label={COPY.bodyLabel}
            onChange={(e) => edit({ body: e.target.value })}
          />
        }
      />
      <SettingsRow
        label={COPY.audienceLabel}
        description={draft.audience === "everyone" ? COPY.everyoneNote : COPY.screenedInNote}
        control={
          <SegmentedControl<Audience>
            options={AUDIENCES}
            value={draft.audience}
            ariaLabel={COPY.audienceLabel}
            onChange={(audience) => edit({ audience })}
          />
        }
      />
      <p className="set-note-inline">{COPY.never}</p>
      <div className="gate-actions">
        <Button onClick={save} disabled={pending}>{pending ? COPY.saving : COPY.save}</Button>
      </div>
      {state === "saved" ? <span className="scn-sg-note">{COPY.saved}</span> : null}
      {state === "failed" ? (
        <span className="scn-sg-note">{complete ? COPY.failed : COPY.incomplete}</span>
      ) : null}
    </>
  );
}
