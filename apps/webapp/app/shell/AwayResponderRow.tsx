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
 * ── AND WHICH MAIL — THE SCOPE'S OTHER HALF, BETWEEN WHO AND HOW OFTEN ───────────────────────
 *
 * "Who gets a reply" is a fact about a SENDER, true from the day they were let in; it says nothing
 * about where their later mail lands, and a shop let in for one receipt was being answered from
 * Reads six months on. So there is a second question on this pane — which piles get a reply — and
 * it stands BETWEEN the audience and the rate because that is the order the Ohbox banner reads the
 * three in: "people you've let in whose mail lands in Ohbox get a reply at most once a day". The
 * offered set is the ENGINE's (`AWAY_ANSWERABLE_PILES`, named through `AWAY_PILE_VIEW`); nothing
 * here lists a pile by hand, so what the control offers and what the pass acts on are one object.
 *
 * The full never-list — mailing lists, no-reply addresses, security mail, receipts, spam, senders
 * screened out, the account's own addresses, bounced addresses — is the gloss beside that control's
 * label: stated once, in full, where the person asking WHICH mail is answered is the person asking
 * what never is. NONE OF IT IS ENFORCED HERE — the suppressions are
 * `packages/core/src/away-eligibility.ts`'s and this component only reports them. So that sentence
 * is a claim about somebody else's code, which makes it the one thing in this file that can go
 * quietly false: if a guard is ever relaxed, it has to be edited in the same change, and a promise
 * of protection may never be added there before the guard exists.
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
import { Button, DatePicker, Gloss, SegmentedControl, SettingsActions, SettingsField, SettingsRow, Switch, TextField } from "@ohmail/ui";
import {
  AWAY_ANSWERABLE_PILES, AWAY_PILE_VIEW, AWAY_PILES_DEFAULT, AWAY_SCREENER_FOLDER,
  awayEffectivePiles, type AwayPile,
} from "@trafficflow/core/away-scope";
import { away as awayApi, type AwayResponderSaveWire, type AwayResponderWire } from "../api-client";
import { dayEnd, dayStamp, dayValue, tomorrowNine } from "./format";
import { activeFormatLocale } from "./locale";

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
  /**
   * WHICH PILES GET A REPLY — the control's own label and the two piles it may offer.
   *
   * The offered SET is not listed here: it is `AWAY_ANSWERABLE_PILES`, imported from
   * `@trafficflow/core/away-scope`, so a control cannot offer a pile the engine refuses. These are
   * only the words for the two members it can hold.
   */
  pilesLabel: "Which mail gets a reply",
  pileOhbox: "Ohbox",
  pileReads: "Reads",
  pileReceipts: "Receipts",
  pileScreener: "Screener",
  pileOhboxNote: "Always answered.",
  /** Why the Screener box cannot be ticked — the audience above decides that population. */
  pileScreenerNote: "Only with “Everyone who writes”, above.",
  /**
   * What is never answered, and what the Screener follows. Spam is the only pile with no box; the
   * Screener has one, and it is the audience above that decides whether it can be used.
   */
  pilesNote: "Spam is never answered. The Screener follows who gets a reply, above.",
  never:
    "Never sent to mailing lists, no-reply addresses, a site or server's own notification "
    + "mailbox, security mail, spam, senders you've screened out, your own addresses, or an "
    + "address that bounced.",
  /** The end date, and the two sentences the pane says about it. */
  untilLabel: "Turn off automatically on",
  untilNone: "No end date",
  untilPick: "Pick a date",
  untilClear: "Remove the end date",
  untilOn: "On until {date}.",
  untilPast: "The end date passed on {date}. Nothing is sent.",
  untilExpired: "Pick a date in the future, or turn the responder off.",
  localNote: "Replies are sent while ohmail is open on this computer.",
  hostNote: "Replies are sent while ohmail is open on {host}.",
  save: "Save",
  saving: "Saving…",
  saved: "Saved.",
  /**
   * THE SAVE LEFT THIS INSTALL — 202 `pending`, on an account whose mailboxes another install
   * organizes. Nothing was written here, the controls show what is still stored, and this is the
   * sentence that says why. "Saved." over reverted values was the false state ruling 6 exists to
   * end, arriving one layer above the write.
   */
  asked: "Not saved here — the machine that organizes this mailbox applies it on its next pass.",
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
  /** Answers {@link AwayResponderSaveWire}: the row, plus `pending` when the edit had to travel. */
  save: (next: Omit<AwayResponderWire, "updatedAt">) => Promise<AwayResponderSaveWire>;
}

/** The two audiences, in the order the control draws them. Labels are resolved at render. */
const AUDIENCE_IDS: readonly Audience[] = ["screened_in", "everyone"];

type Throttle = AwayResponderWire["throttle"];
type Piles = AwayResponderWire["piles"];

/**
 * THE LABEL KEY FOR EACH PILE WORD — keyed by the VIEW word, never by the folder. The offered set
 * is `AWAY_ANSWERABLE_PILES` (the control iterates it) and `AWAY_PILE_VIEW` says what each member
 * is called; this only turns that word into a catalogue key. `satisfies` closes it over the view
 * words, so a pile the engine starts offering under a NEW word fails to compile here rather than
 * rendering with no label — and a new folder under an existing word renders with no edit at all.
 */
const PILE_LABEL = {
  ohbox: "pileOhbox", reads: "pileReads", receipts: "pileReceipts", screener: "pileScreener",
} as const satisfies Record<(typeof AWAY_PILE_VIEW)[AwayPile], string>;

/**
 * The four rates, LOOSEST FIRST, which is the order the sentence they form reads in: every message,
 * then once per text, then a day, then a week. `per_day` is the default and sits third rather than
 * first on purpose — the control shows where the default sits on a range, instead of presenting it
 * as the leading option and the rest as departures from it.
 */
const THROTTLE_IDS: readonly Throttle[] = ["always", "per_message", "per_day", "per_week"];

/**
 * HOW OFTEN AND HOW LONG the `asked` watcher asks. See {@link watchForApplied}.
 *
 * The organizing machine's own cycle is tens of seconds and the request travels through the
 * mailbox, so the interval is the cheaper of the two clocks to be wrong about. The COUNT is the
 * part that matters: a settings row must not leave a timer running for the life of a tab.
 */
const ASKED_POLL_MS = 20_000;
const ASKED_POLL_MAX = 12;

type Draft = Omit<AwayResponderWire, "updatedAt">;

const RESTING: Draft = {
  enabled: false, body: null, startsAt: null, endsAt: null,
  audience: "screened_in", throttle: "per_day", piles: [...AWAY_PILES_DEFAULT],
};

export function AwayResponderRow({ onChanged, transport, local = false, host = null }: {
  /**
   * THE SHELL'S ECHO — how the Ohbox notice (`AwayNotice.tsx`) learns of a same-tab edit
   * without a refetch. Called with what the SERVER answered — the mount load and every save
   * echo, never what a click asked for — so the row and any listener can only agree.
   * Optional: this row predates the notice, and a mount with nothing to tell stays valid.
   */
  onChanged?: (
    state: {
      enabled: boolean; audience: Audience; throttle: Throttle;
      /** The stored scope, so the Ohbox notice's sentence names it without a second read. */
      piles: Piles;
    },
  ) => void;
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
  /**
   * THE OTHER COMPUTER THIS INSTALL IS PAIRED TO, when it is — the THIRD promise, and it is a
   * name rather than a third boolean for the reason the sentence needs one.
   *
   * A paired desktop's responder is the HOST's row and the host's drain sends from it. So neither
   * of the two sentences above is true here: the hosted one promises an always-on service, and
   * `localNote` names THIS computer while the machine that has to be awake is the other one.
   * Naming it is the whole content of the difference — "while ohmail is open on {host}" tells
   * somebody which machine to leave running, and "on this computer" tells them the wrong one.
   *
   * `null` is the resting state and covers both other doors. When it is set it WINS over `local`:
   * `awayDoorFor` answers exactly one arm, so the two can never both be true in this app, and a
   * caller that got that wrong would be showing two promises about one responder.
   */
  host?: string | null;
} = {}) {
  const t = useTranslations("away");
  /* THE PICKER'S OWN CHROME — "Previous month", "Next month", "today". One set of words for every
     date picker in the product; a copy of the three in this namespace would be three strings to
     keep in agreement with the resurface chooser's. */
  const tOhbox = useTranslations("ohbox");
  const tScreener = useTranslations("screener");
  /**
   * `null` until the server has answered. The controls are not drawn before then, for the reason
   * `RemoteImagesRow` gives about its own switch and more sharply: drawing the resting OFF state to
   * somebody whose responder is ON, who then leaves the pane, would show them a responder that is
   * not sending while it is.
   */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  /**
   * `asked` IS NOT `saved`, and it is the one distinction this row's answer has to carry: on an
   * account another install organizes, the write did not happen here and a request is waiting.
   */
  const [state, setState] = useState<"idle" | "saved" | "asked" | "applied" | "failed" | "expired">("idle");
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
  /** The end-date picker: open, and the control it hangs from — the resurface chooser's idiom. */
  const [dateOpen, setDateOpen] = useState(false);
  const dateRef = useRef<HTMLSpanElement | null>(null);

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
  /** The `asked` watcher's pending tick, so leaving the pane stops it. See {@link watchForApplied}. */
  const askedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (askedTimer.current !== null) clearTimeout(askedTimer.current);
    };
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
          /* `PUT` is a FULL REPLACE, so the draft carries the stored scope from the load, and a
             server one release older (no `piles` in its answer) reads as the default — the narrow
             one — rather than as an empty scope a save would then write. The control below edits
             this field; the save echoes whatever the server stored. */
          piles: loaded.piles ?? [...AWAY_PILES_DEFAULT],
        });
        changed.current?.({
          enabled: loaded.enabled, audience: loaded.audience, throttle: loaded.throttle,
          piles: loaded.piles ?? [...AWAY_PILES_DEFAULT],
        });
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

  /**
   * THE CHOSEN DATE, AND WHETHER IT HAS ALREADY GONE.
   *
   * `endsAt` is an instant (the end of the chosen day where the reader is), so the comparison is
   * against a clock read at render. The pane refuses the save this state would make, and the
   * server refuses it too — see {@link AWAY_COPY.untilExpired}.
   */
  const endsAt = draft.endsAt;
  const expired = endsAt !== null && new Date(endsAt).getTime() < Date.now();

  /** What the responder ACTUALLY answers — the projection the banner reads. See the group below. */
  const effective = awayEffectivePiles(draft.piles, draft.audience);

  /**
   * WAIT FOR THE ORGANIZING MACHINE TO APPLY THE REQUEST — and stop waiting.
   *
   * ── WHY A POLL AT ALL, AND WHY A BOUNDED ONE ────────────────────────────────────────────────
   *
   * The row's own state is the account's, and on a reader it is refreshed from the organizer's
   * published profile by the sync loop. So the answer arrives at `GET /away-responder` on its own;
   * what was missing was anything here that asked again. The discriminator this pane already
   * carries is `updatedAt`: the 202 answers the row UNCHANGED, so the first read whose `updatedAt`
   * differs is the organizer's write.
   *
   * BOUNDED, on purpose. An unbounded poll on a settings row is a timer nobody switches off, and
   * a pane left open overnight would keep asking for ever about a request that may have been
   * refused. {@link ASKED_POLL_MAX} attempts at {@link ASKED_POLL_MS} is a few minutes — several
   * organizer cycles — after which `asked` simply stands, which is still the true sentence: the
   * request is waiting. Coming back to the pane re-reads on mount.
   *
   * A read that throws is not a state: the request may still land, so the attempt is spent and the
   * wait continues rather than turning a transient refusal into "that did not save".
   */
  const watchForApplied = (askedAt: string | null): void => {
    let left = ASKED_POLL_MAX;
    const tick = (): void => {
      askedTimer.current = setTimeout(() => {
        void (async () => {
          if (!alive.current) return;
          left -= 1;
          try {
            const now = await wireOf().state();
            if (!alive.current) return;
            if (now.updatedAt !== askedAt) {
              setDraft({
                enabled: now.enabled, body: now.body,
                startsAt: now.startsAt, endsAt: now.endsAt,
                audience: now.audience, throttle: now.throttle,
                piles: now.piles ?? [...AWAY_PILES_DEFAULT],
              });
              changed.current?.({
                enabled: now.enabled, audience: now.audience, throttle: now.throttle,
                piles: now.piles ?? [...AWAY_PILES_DEFAULT],
              });
              setState("applied");
              return;
            }
          } catch {
            /* Still waiting. See the header: a refused read is not an answer about the request. */
          }
          if (left > 0) tick();
        })();
      }, ASKED_POLL_MS);
    };
    tick();
  };

  const save = (): void => {
    if (pending || !draft) return;
    // The worker refuses to compose, so an enabled responder with nothing written in it would be
    // stored and then do nothing at all. Refused here too, where somebody can see why.
    if (draft.enabled && !complete) { setState("failed"); return; }
    /* AND AN END DATE THAT HAS ALREADY PASSED, while the responder is on: the server answers 400
       for it, and a bare "That did not save." would not say which field. */
    if (draft.enabled && expired) { setState("expired"); return; }
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
          piles: stored.piles ?? [...AWAY_PILES_DEFAULT],
        });
        changed.current?.({
          enabled: stored.enabled, audience: stored.audience, throttle: stored.throttle,
          piles: stored.piles ?? [...AWAY_PILES_DEFAULT],
        });
        /* THE 202's DISCRIMINATOR DECIDES THE SENTENCE. `stored` is the row as it stands HERE —
           the saved one when the write happened here, the UNCHANGED one when it travelled — so
           without this the pane put the old values back and said "Saved." over them. */
        if (stored.pending === true) {
          setState("asked");
          /* AND `asked` IS A STATE THAT HAS TO END. It says the organizing machine "applies it on
             its next pass", and nothing here could ever learn that it had: no poll, no
             subscription, no acknowledgement. So a pane left open showed the OLD values with a
             note about a request that had already landed — a false state about what strangers are
             told, which is the same defect the 202 discriminator was added to fix, one step later.
             `watchForApplied` ends it, and the load effect's own read is what ends it for anyone
             who left the pane and came back. */
          watchForApplied(stored.updatedAt);
        } else {
          setState("saved");
        }
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
        <TextField
          multiline
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
            /* NARROWING THE AUDIENCE DROPS THE SCREENER PILE, because the pair is refused at the
               write door and inert in the rule — `awayEffectivePiles` is the same projection the
               banner reads, so the draft, the save and the sentence agree. */
            onChange={(audience) => edit({
              audience, piles: [...awayEffectivePiles(draft.piles, audience)] as Piles,
            })}
          />
        }
      />
      {/* WHICH MAIL — see the header. A checkbox group in the choice list's own dress (`.set-choice`:
          one card per option, the accent wash on a ticked one), under the field grammar (label above,
          hint below), because two options with a consequence each are a list and not a segmented
          range. Native checkboxes: Space toggles, the group is named by its label for a reader.

          THE OHBOX CANNOT BE SWITCHED OFF HERE — a responder answering nothing is not a responder —
          so its box is checked and disabled whenever the stored scope holds it. It is NOT forced on:
          the column's CHECK admits a scope without the Ohbox (reachable through the API), and drawing
          a tick over a stored scope that lacks it would state a reply is going out to mail that gets
          none — the exact false claim `awayScopeKey` exists to keep out of the banner. A stored scope
          without the Ohbox shows the box unticked and pressable, so the way back to the default is
          one press; `pileOhboxNote` is drawn only while it is true.

          The never-list is the gloss beside the label (placement `chip`, so the glyph sits on the
          label's line, and bound to the label's last word by a no-break space so a wrapping label
          never leaves the glyph alone on a line — measured at 360px in German). Its whole sentence
          is the trigger's accessible name. The group's OWN name is the label alone — the gloss
          stands outside the labelling span so a reader is not handed the exclusion list as the
          group's title — and its description is the note below the options.

          THE NOTE IS MICROCOPY, NOT A FIELD HINT. `.set-field-hint` takes the phone input floor
          (16px below 640px) because it stands under a text input of that size; under two option
          cards it outweighed every other line on the pane — measured at 360 and 390. So it is the
          pane's own `set-note-inline`, the size the audience's and the standalone door's notes take,
          and it stands after the field so the rate row below still draws its rule. */}
      <div className="set-field" role="group" aria-labelledby="away-piles-label" aria-describedby="away-piles-note">
        <span className="set-field-label">
          <span id="away-piles-label">{t("pilesLabel")}</span>
          {"\u00a0"}
          <Gloss placement="chip" text={t("never")} />
        </span>
        <div className="set-choice">
          {AWAY_ANSWERABLE_PILES.map((pile) => {
            /* TICKED IS THE EFFECTIVE SCOPE, not the stored array. A stored `ohmail/Screener`
               beside `screened_in` answers nobody (the audience is asked first), so drawing it
               ticked would state a reply going out where none is. */
            const on = effective.includes(pile);
            const word = AWAY_PILE_VIEW[pile];
            const fixed = word === "ohbox" && on;
            /* THE SCREENER FOLLOWS THE AUDIENCE — the one coupling between the two settings, and
               the reason its row carries a note instead of just going grey. */
            const audienceLocked = pile === AWAY_SCREENER_FOLDER && draft.audience !== "everyone";
            return (
              <label key={pile}>
                <input
                  type="checkbox"
                  name="away-piles"
                  value={pile}
                  checked={on}
                  disabled={pending || fixed || audienceLocked}
                  onChange={(e) => edit({
                    /* Filtered over the ENGINE's set, in its order: a toggle can only ever add or
                       remove a member the engine offers, and never reorders or invents one. */
                    piles: AWAY_ANSWERABLE_PILES
                      .filter((p) => (p === pile ? e.target.checked : effective.includes(p))),
                  })}
                />
                <b>{t(PILE_LABEL[word])}</b>
                {fixed ? <span>{t("pileOhboxNote")}</span> : null}
                {audienceLocked ? <span>{t("pileScreenerNote")}</span> : null}
              </label>
            );
          })}
        </div>
      </div>
      <p className="set-note-inline" id="away-piles-note">{t("pilesNote")}</p>
      {/* THE END DATE. `endsAt` has always been in this row's draft and in the wire — the pass
          stops answering past it — and until now there was no control for it, so the only way to
          set one was the API. The product's own `DatePicker` rather than a native date input, for
          the reason that primitive exists: the operating system drew its calendar wherever it
          liked. Floored at TOMORROW, so no date already gone can be chosen here; the picker is
          the only writer, and a date that has since passed is reported below rather than hidden.

          The day is resolved at the END of itself where the reader is (`dayEnd`), and read back
          as the same day (`dayValue`), so the two directions cannot name different dates. */}
      <SettingsField htmlFor="away-until" label={t("untilLabel")}>
        <span className="set-inline-pair">
          {/* THE ANCHOR IS THE SPAN, not the button: `Button` is not a `forwardRef` component and
              making it one would change a primitive every pane in the product draws. The span
              wraps the trigger alone, so its box IS the trigger's box, which is what the picker
              measures its placement from. */}
          <span ref={dateRef}>
            <Button
              id="away-until"
              disabled={pending}
              aria-haspopup="dialog"
              aria-expanded={dateOpen}
              onClick={() => setDateOpen((open) => !open)}
            >
              {endsAt === null ? t("untilNone") : dayStamp(endsAt)}
            </Button>
          </span>
          {endsAt === null ? null : (
            <Button variant="ghost" disabled={pending} onClick={() => edit({ endsAt: null })}>
              {t("untilClear")}
            </Button>
          )}
        </span>
        {dateOpen ? (
          <DatePicker
            locale={activeFormatLocale()}
            today={dayValue(new Date().toISOString())}
            min={dayValue(tomorrowNine(new Date()))}
            value={endsAt === null ? null : dayValue(endsAt)}
            anchor={dateRef.current}
            labels={{
              dialog: t("untilPick"),
              prevMonth: tOhbox("datePrevMonth"),
              nextMonth: tOhbox("dateNextMonth"),
              today: tScreener("today"),
            }}
            onPick={(day) => { setDateOpen(false); edit({ endsAt: dayEnd(day) }); }}
            onClose={() => setDateOpen(false)}
          />
        ) : null}
      </SettingsField>
      {/* WHAT THE DATE MEANS RIGHT NOW, and only while it means something. A responder that is off
          already says so in the row's own description, and one with no date has nothing to add. */}
      {draft.enabled && endsAt !== null ? (
        <p className="set-note-inline">
          {expired
            ? t("untilPast", { date: dayStamp(endsAt) })
            : t("untilOn", { date: dayStamp(endsAt) })}
        </p>
      ) : null}
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
      {/* WHAT THE RESPONDER WILL NOT DO is the gloss beside "Which mail gets a reply", above — once,
          in full, on demand. It used to be a standing line here as well; two statements of one
          exclusion list is one more place for the claim to go stale. The per-person rate is likewise
          not restated anywhere: it is the control directly above. */}
      {/* THE STANDALONE PROMISE, and it is only true on that door. An install with no account
          behind it answers mail from THIS machine while the window is open, so "your responder is
          on" would be a promise the app cannot keep overnight. The hosted door keeps it, and says
          nothing extra. `localNote` is rendered on the strength of the transport the host passed,
          not on a guess about the environment — see `AwayTransport`. */}
      {host !== null
        ? <p className="set-note-inline">{t("hostNote", { host })}</p>
        : local ? <p className="set-note-inline">{t("localNote")}</p> : null}
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
        {state === "asked" ? (
          <span className="set-note-inline" role="status">{t("asked")}</span>
        ) : null}
        {state === "applied" ? (
          <span className="set-note-inline" role="status">{t("applied")}</span>
        ) : null}
        {state === "failed" ? (
          <span className="set-note-inline" role="alert">{complete ? t("failed") : t("incomplete")}</span>
        ) : null}
        {state === "expired" ? (
          <span className="set-note-inline" role="alert">{t("untilExpired")}</span>
        ) : null}
      </SettingsActions>
    </>
  );
}
