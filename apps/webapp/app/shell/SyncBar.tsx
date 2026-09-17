"use client";

/**
 * The shell's sync strip — everything the product has to say about a sync, said wherever you are
 * standing. "Sync failed. Retrying." used to render only in the Ohbox's empty state, so the one
 * mailbox that could be told its sync was broken had never loaded anything, while a list of four
 * hundred ten-minute-old rows looked healthy — found three times, because each fix was another
 * branch inside a view. First import had the same gap: `mailboxes.syncPending` lived three clicks
 * away in Settings while a multi-minute worker import ran in silence. So the strip renders the
 * whole ladder in `mail-state.ts` and this file decides NOTHING — a switch over a key somebody else
 * derived: a view cannot forget it, and a seventh state cannot be invented here.
 */

/**
 * Why a shell strip and not a per-view banner: rendered once above the deck, so it covers every
 * view; a `flex: none` row of `.shell`, outside every list's scroller by construction; silent when
 * healthy — `quiet` renders `null` (the demo and Desktop are gated to `quiet` in the derivation).
 * `terminal` means the server refused this session in a way no waiting fixes and the loop has
 * stopped — "Retrying." would be false, so it gets its own line and the one remedy; everything
 * else genuinely retries and says so. The importing count is not announced by the VISIBLE line and
 * not hidden: the stable half announces once, the volatile half carries `aria-live="off"`, because
 * a number that steps several times a second supersedes its own announcement before a reader hears
 * one. What was missing is that it was then never spoken at all — a first import ran to a screen
 * reader as one sentence and nothing after it. {@link SyncAnnouncer} says the whole sentence on a
 * throttle instead.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Spinner } from "@ohmail/ui";
import { useTranslations } from "next-intl";
import { apiConfigured } from "../api-client";
import { useMailState } from "./MailStateProvider";
import { useDrainInFlight } from "./drain-mark";
// The strip names a mailbox in every arm that has one, and every one of those is a sentence a
// person reads — so the address is decoded for display (`idn.ts`). `MailState` itself keeps the
// stored form, which is what the settings link and the probe compare against.
import { displayAddress } from "./idn";
// The stale label's time — "Mon 18:40" in the app's own locale, through the one stamp
// formatter the waterline already uses rather than a second spelling of the same idea.
import { waterlineStamp } from "./format";
import { activeFormatLocale, activeFormatZone } from "./locale";
import { clock } from "@ohmail/client-engine";
import { POLL_MS } from "./sync-scheduler";

/**
 * "14:32" in the reader's own zone — the `as of` and `next try at` halves of the filing sentences.
 * The engine's own `clock`, not a second `Intl` call: every stamp goes through one formatter
 * reading one zone seam (`activeFormatZone`), and a strip naming a different hour from the rows
 * beneath it is the defect `waterlineStamp`'s comment records. A time and not a date, deliberately:
 * both sentences are about the last few minutes, and a date would invite reading the strip as an
 * event log. An unparseable instant answers null and the clause is dropped — "as of Invalid
 * Date" is worse than no clause.
 */
function clockTime(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return clock(at, activeFormatZone());
}

/**
 * The mailbox address a strip arm names, readably — and `null` straight through, because two of
 * these arms carry `address: string | null` and "we do not know which mailbox" must stay a missing
 * detail rather than become an empty one.
 */
const readable = (address: string | null): string | null =>
  address === null ? null : displayAddress(address);
import { stripSpeaks, type MailState } from "./mail-state";
/* The one place any surface asks whether a phone holds the mailbox — see `reader-holder.ts`. */
import { filingElsewhereKey, phoneHolder, phoneHolderKey } from "./reader-holder";
import { readingAlong } from "./reading-along";

/**
 * Rendered twice, in two shapes. The rail carries everything that acts on the app rather than on mail, so
 * the shell renders `variant="rail"` into the rail's slot and keeps `variant="shell"` where it was;
 * `app.css` shows exactly one (under 900px the rail collapses into a drawer, and a sync line in a closed
 * drawer tells nobody anything). `display:none`, not a JS width test: the hidden copy leaves the
 * accessibility tree too, so two `role="status"` regions never announce twice. Written as ONE stylesheet
 * rule: two complementary-looking queries left a fractional width where both copies painted
 * (`test/sync-notice-one-copy.test.ts` sweeps it). DOM readers: the hidden strip is the first text match
 * — the visible one is in the rail. `speech()` is the one description both shapes read.
 */
/**
 * HOW OFTEN THE STRIP MAY SPEAK — and neither number is picked blind.
 *
 * The floor is the product's OWN steady cadence for this fact: `POLL_MS`, the visible tab's drain
 * interval, which is how fast the count moves once a mailbox is settled. Under it the counter steps
 * per applied page, measured in the perf harness at three commits in the busiest second with a 101 ms
 * median gap between them — faster than a polite announcement can be spoken, so every one would
 * supersede the last and the reader would hear a stutter and never a sentence. The second gate exists
 * because a long import would otherwise announce every eight seconds for an hour: where a denominator
 * is known, no more than one announcement per 5% of it.
 */
const ANNOUNCE_MS = POLL_MS;
const ANNOUNCE_STEP = 0.05;

/**
 * The strip's sentence, spoken. Its own component because {@link SyncBar} returns early for the
 * quiet states, and a hook may not sit behind that.
 *
 * `aria-atomic`, so the count is heard inside its sentence rather than as a bare number; INSIDE the
 * strip, so the `display:none` copy's announcer goes with it and the two variants cannot both speak.
 * The first update is announced at once — the reader is told an import is running — and after that
 * both gates apply, with a trailing timer so a suppressed last number is not lost when the count
 * stops moving.
 */
function SyncAnnouncer({ say, progress }: { say: string | null; progress: number | null }) {
  const [said, setSaid] = useState("");
  const last = useRef<{ at: number; step: number } | null>(null);
  useEffect(() => {
    if (say === null) return;
    const step = progress === null ? -1 : Math.floor(progress / ANNOUNCE_STEP);
    const now = Date.now();
    const prev = last.current;
    const timeOk = prev === null || now - prev.at >= ANNOUNCE_MS;
    const stepOk = prev === null || step === -1 || step !== prev.step;
    if (timeOk && stepOk) {
      last.current = { at: now, step };
      setSaid(say);
      return;
    }
    if (!stepOk) return;
    const id = setTimeout(() => {
      last.current = { at: Date.now(), step };
      setSaid(say);
    }, ANNOUNCE_MS - (now - prev!.at));
    return () => clearTimeout(id);
  }, [say, progress]);
  if (say === null) return null;
  return (
    <span className="sync-say" role="status" aria-live="polite" aria-atomic="true">
      {said}
    </span>
  );
}

/* No default VALUE on the parameter, only on the field. A `= {}` there types the component as
   `(props?: …)`, which is not a `FunctionComponent<P>`, and `createElement(SyncBar, { variant })`
   then resolves to the propless overload and rejects the prop it was given. */
export function SyncBar({ variant = "shell", hostOffline = false }: {
  variant?: "shell" | "rail";
  /**
   * Is this window paired to a computer that is not answering? — then the `stale` arm yields.
   * `staleAsOf` reads "As of {time} · catching up" with a spinner: an ACTIVITY claim, and on a
   * paired desktop whose host is off nothing is catching up — the sentence would be false for
   * exactly the period a person is trying to understand. So the strip says nothing and
   * `HostConnectionLine` says the true thing in its place. The state itself is not suppressed: the
   * ladder still derives `stale` (`mail-state.ts`), so the settled clock and the holdings sentence
   * go on working — this withholds one sentence, not a fact. The other six arms are untouched: a
   * paired desktop can still be signed out, blocked or importing.
   */
  hostOffline?: boolean;
}) {
  const t = useTranslations("sync");
  // The error TAXONOMY lives with the Settings rows that already own it (`mailboxes.err_*`,
  // mail 0023). Two copies of seven sentences is how they drift, and one of them then describes
  // a failure mode the other has renamed.
  const tm = useTranslations("mailboxes");
  const { state } = useMailState();
  /* WHETHER ANYTHING IS ACTUALLY RUNNING — before the early returns, because a hook may not sit
     behind one. The busy STATES say a sync is outstanding; this says a drain is in flight now,
     and only it may move a mark (`drain-mark.ts`). */
  const draining = useDrainInFlight();

  if (!stripSpeaks(state.key)) return null;
  /* THE ONE ARM THAT YIELDS. Placed before `speech()` rather than inside it so the suppression is
     visible at the top of the render — a seventh `speech()` arm returning a null title would have
     to be handled by both shapes below and would read as a state rather than as a withheld
     sentence. See the `hostOffline` prop. */
  if (hostOffline && state.key === "stale") return null;
  // WHICH DOOR this install came in by. `apiConfigured()` is false exactly on the build with no
  // Cloud behind it — the standalone desktop, which folds `NEXT_PUBLIC_API_BASE` away at build
  // time — so it is the seam the `stopped` sentence branches on. See `speech()`'s `stopped` arm.
  const cloud = apiConfigured();
  const s = speech(state, t, tm, cloud);
  /* THE MOVING MARKS — the spinner and the travelling sliver — and the one condition both may
     mean. A busy state with no drain in flight is a sync that is outstanding and not moving:
     it keeps its sentence, its tone and its track, and says so standing still. Both marks are
     gated together because the frames they cost are bought by the first one (measured on the
     Omarchy guest: one 1 952, two 1 953 milli-cores), so stopping one of a pair saves nothing. */
  const marks = s.busy && draining;

  if (variant === "rail") {
    return (
      <div
        className={s.tone ? `rail-sync ${s.tone}` : "rail-sync"}
        role={s.role}
        aria-live={s.role === "status" ? "polite" : undefined}
      >
        <div className="rs-line">
          <Glyph warn={s.warn} busy={marks} />
          <b>{s.title}</b>
        </div>
        {/* The volatile half, on its own line at rail width: an address plus an elapsed count
            has nowhere to go beside a label in 200px, and the alternative — ellipsising it — is
            hiding the one part of the sentence that MOVES. */}
        {s.detail ? (
          <span className="rs-num num" aria-live="off">
            {s.detail}
          </span>
        ) : null}
        {/* THE PROGRESS LINE, and it is indeterminate on purpose. `/sync` answers `hasMore` as a
            boolean, so the total is unknowable until the drain ends; a filled track or a
            percentage would be invented. The TRACK is the affordance and stands for as long as
            the sync is outstanding; the travelling sliver inside it is the motion and exists
            only while a drain is in flight, so a bar moving over a sync making no progress
            cannot be rendered. `aria-hidden`: the region already says it in words.
            `prefers-reduced-motion` stops the travel and leaves the track (app.css). */}
        {s.busy ? (
          <span className="rs-track" aria-hidden="true">
            {marks ? <i /> : null}
          </span>
        ) : null}
        {s.link ? <a href={s.link.href}>{s.link.label}</a> : null}
        <SyncAnnouncer say={s.say ?? null} progress={s.progress ?? null} />
      </div>
    );
  }

  return (
    <div
      className={s.tone ? `sync-bar ${s.tone}` : "sync-bar"}
      role={s.role}
      aria-live={s.role === "status" ? "polite" : undefined}
    >
      <Glyph warn={s.warn} busy={marks} />
      <b>{s.title}</b>
      {s.detail ? (
        <span className="num" aria-live="off">
          {s.detail}
        </span>
      ) : null}
      {s.link ? <a href={s.link.href}>{s.link.label}</a> : null}
      <SyncAnnouncer say={s.say ?? null} progress={s.progress ?? null} />
    </div>
  );
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Everything either shape needs to know, for one state. */
interface Speech {
  /** The modifier the tone classes hang off — `""` is the plain accent ground. */
  tone: "" | "stopped" | "warn" | "busy";
  /**
   * `alert` for `stopped` and `status` for the rest. The loop has ENDED in that one state and
   * will not restart itself, which is the only sync fact worth interrupting a screen reader
   * for; everything else is still being retried and says so calmly. `terminal` is not set-once —
   * a wake issues one bounded probe and a drain that succeeds withdraws the claim — so this can
   * appear, go and reappear, and re-announcing on a re-latch is correct: the server re-made it.
   */
  role: "alert" | "status";
  warn: boolean;
  busy: boolean;
  title: string;
  /** The volatile half — a climbing count, an elapsed minute, an address. Never announced HERE. */
  detail: ReactNode | null;
  /**
   * THE WHOLE SENTENCE, SPOKEN — title and volatile half in one string, built from the very
   * expressions the two halves are drawn from so they cannot drift. Absent ⇒ the volatile half is
   * not worth speaking and the region above already says the stable one. See {@link SyncAnnouncer}.
   */
  say?: string | null;
  /** 0..1 where a denominator is known — the second gate on how often the sentence may be said. */
  progress?: number | null;
  link: { href: string; label: string } | null;
}

function speech(state: MailState, t: Translate, tm: Translate, cloud: boolean): Speech {
  const settings = { href: "#/settings", label: t("settings") };
  switch (state.key) {
    case "stopped":
      return {
        tone: "stopped", role: "alert", warn: true, busy: false,
        // TWO DOORS, ONE STATE. `terminal` means our API refused this session and re-made the
        // refusal — a revoked Cloud session on the web, or a local engine whose injected bearer
        // skewed (it rotates on sidecar restart) on the standalone desktop. The remedy is not the
        // same sentence in both: a signed-in Cloud user signs in again, but a standalone install
        // has NO Cloud account and no `/login`, so sending it there is a dead end. It relaunches
        // instead. An earlier note here claimed this branch was "Cloud-only by construction"
        // because "a fixtures engine is permanently settled" — true of the demo and the desktop
        // PREVIEW, false of the local-engine desktop, which runs the real HttpAdapter over its
        // bridge and reaches `terminal` on exactly that bearer skew.
        title: cloud ? t("stopped") : t("stoppedLocal"),
        detail: null,
        link: cloud ? { href: "/login", label: t("signIn") } : null,
      };

    case "ownerLost":
      // THE MARKER CHANGED UNDER A LIVE WINDOW. `status`, not `alert`, and no "sign in again":
      // nothing was refused and nobody said this session is over — the browser stopped naming
      // the account this mirror belongs to, which happens on a sign-in elsewhere, a sign-out in
      // another tab, or a cookie the browser simply lost. What was wrong was standing down in
      // silence: the mirror takes no pages, a press is queued rather than sent, and the page
      // looked healthy. The link is a real recovery rather than advice — a full page load asks
      // `GET /auth/session`, which mints an absent marker back.
      return {
        tone: "", role: "status", warn: true, busy: false,
        title: t("ownerLost"), detail: null,
        link: { href: "/mailbox", label: t("reload") },
      };

    case "failing":
      // Polite, and deliberately not re-announced: the text is constant for as long as the
      // outage lasts, so the region updates once when it appears and once when it goes.
      return { tone: "", role: "status", warn: true, busy: false, title: t("failing"), detail: null, link: null };

    case "stale":
      // THE FRESHNESS CONTRACT'S LABEL (INSTANT-ARCH §6.6): the mail on screen is real and this
      // says how old — "As of Mon 18:40 · catching up". Busy tone and no warning triangle,
      // because nothing is wrong: the mirror painted instantly (frame one is local) and a drain
      // is converging behind content that is already readable. It clears itself — the arm stops
      // matching the moment a drain settles and re-stamps. The time is stable for the whole
      // episode (the stamp only moves when the state exits), so the live region announces the
      // sentence once. `state.asOf` is non-null by the ladder's own guard; the stamp is
      // machine-written, so `waterlineStamp`'s empty-string fallback is unreachable rather than
      // load-bearing.
      return {
        tone: "busy", role: "status", warn: false, busy: true,
        title: t("staleAsOf", { time: waterlineStamp(state.asOf ?? "", activeFormatLocale()) }),
        detail: null, link: null,
      };

    case "catchingUp":
      // The confirm window for a coded refusal. Our API refused this session ONCE and we are
      // asking again to see if it holds (REFUSAL_CONFIRM_MS). Calm and busy — a spinner, no
      // warning triangle — because nothing is confirmed: this is NOT `stopped`'s alert and NOT
      // `failing`'s "Sync failed." A coded refusal must never be answered with silence, so the
      // strip says the one true calm thing meanwhile; if the refusal is re-made it becomes
      // `stopped`, and if a drain succeeds it withdraws to quiet.
      return { tone: "busy", role: "status", warn: false, busy: true, title: t("catchingUp"), detail: null, link: null };

    case "blocked":
      return {
        tone: "warn", role: "status", warn: true, busy: false,
        // A reason this build does not recognise still gets a sentence. The server owns a
        // CLOSED set (mail 0029) and this client re-declares it, so a fourth member is a real
        // possibility during a deploy — and answering it with silence would restore precisely
        // the invisibility that migration exists to end.
        title: state.reason ? t(`blocked_${state.reason}`) : t("blockedUnknown"),
        detail: (
          <>
            {readable(state.address)}
            <Since minutes={state.minutes} t={t} />
          </>
        ),
        // `awaiting_credentials` is the one arm a user can act on — the mailbox needs its
        // password stored again. The other two are ours, and the link is still right: that pane
        // is where the mailbox and its state live.
        link: settings,
      };

    case "mailboxError":
      return {
        tone: "warn", role: "status", warn: true, busy: false,
        title: tm(`err_${state.errorCode}`),
        detail: readable(state.address),
        link: settings,
      };

    case "filing": {
      /**
       * FOUR SENTENCES, NOT ONE (mail 0097): This arm rendered one sentence — "Filing N messages on your mail server…
       * · your decisions are already applied here; the server is catching up." — for every reason a filing can be
       * outstanding, and the second clause was FALSE in two of them: a deferred row is not being caught up with, and
       * on a reader install the server is not the organizer at all. `mail-state.ts`'s {@link FilingArm} carries the
       * reported sighting and the four cases. `state.filing === null` is the OLDER SERVER and it keeps the original
       * pair of sentences, minus the false clause: the count is still true, and a build that cannot say why must not
       * be made to guess.
       */
      const f = state.filing;
      const asOf = f?.asOf ? clockTime(f.asOf) : null;
      /* TWO KEYS, AND THE UNDATED ONE IS NOT REDUNDANT. `asOf` comes from the aggregate, which an
         older server does not send — and gating the address line on it dropped the line entirely
         for exactly those servers, which `sync-bar-loader.test.ts` caught: the strip stopped
         naming the mailbox it had always named. The date is an ADDITION to that sentence, so it
         gets its own key and the original keeps working with nothing but an address. */
      const where = state.address === null ? null
        : asOf
          ? t("filingWhereAsOf", { address: displayAddress(state.address), at: asOf })
          : t("filingWhere", { address: displayAddress(state.address) });

      /* WHO FILES IT. Never `warn`: nothing has failed and nothing on this side is late — the
       * mailbox is organized somewhere else, which is a configuration the person chose. Never
       * `busy` either, because this install is not doing anything about it. */
      /* ── SOMEBODY WHO HAS DECIDED THIS IS RIGHT IS NOT TOLD IT AGAIN (issue #5) ──────────
         The strip is where the sentence is most relentless: it is on screen at all times and
         re-renders on every poll. One press in Settings → Mailboxes says "I'm reading along
         here", and while that intention stands FOR THIS HOLDER this arm is skipped and the strip
         falls through to the ordinary sentences about our own side, which are true — it does not
         go blank, and the filing count is not hidden by the arms below. A DIFFERENT holder
         re-shows it: the intention is about one install, not about the mailbox. */
      const readingAlongHere = Boolean(f?.who && readingAlong(f.who.mailboxId, {
        kind: f.who.kind, name: f.who.name, stopped: f.who.stopped, since: f.who.since,
      }));
      if (f?.arm === "elsewhere" && !readingAlongHere) {
        const name = f.who?.name;
        /* A PHONE IS THE THIRD KIND THE LEASE RECORDS and this rail had arms for two, so a phone
           fell to `filingElsewhereUnknown` — "Another ohmail install files this mailbox on its
           own schedule" — which is false twice over: a phone organizes while its app is OPEN,
           never on a schedule, and a phone whose claim has LAPSED is filing nothing at all. Both
           of its sentences come from `phoneHolderKey`, the one table every surface asks; the
           title has room for the clause, so the rail takes the full form. */
        const phone = phoneHolder(f.who, f.who?.stopped === true);
        /* ── AND WHAT TO PRESS, WHICH THIS STRIP NEVER SAID (issue #5) ─────────────────────
           Four sentences naming who files the mailbox, and not one of them said how to take it
           back — the strip's only affordance was a link, and a link is not an instruction. The
           verb is `takeover` because Settings → Mailboxes is where that press lives and this
           rail is served on the door that has it; the sentence names it. `filingElsewhereKey`
           is the table, so the strip and the pane cannot word one state two ways. */
        const title = phone
          ? tm(phoneHolderKey(phone, "full"), { name: name ?? "" })
          : t(filingElsewhereKey(
            { kind: f.who?.kind ?? null, name: name ?? null, stopped: f.who?.stopped === true },
            "takeover",
          ), { name: name ?? "" });
        return {
          tone: "", role: "status", warn: false, busy: false,
          title,
          detail: t("filingElsewhere", { count: f.count }),
          // Settings → Mailboxes is where the organizing can be moved to this install, which is
          // the one thing a person can do about this.
          link: settings,
        };
      }

      /* STUCK. The one arm that WARNS, and it is data-driven: the oldest outstanding filing has
       * waited past what a rotation can account for, or the ladder has refused it twice. */
      if (f?.arm === "stuck") {
        return {
          tone: "warn", role: "status", warn: true, busy: false,
          title: t("filingStuck", { count: f.count, minutes: f.waitedMinutes ?? 0 }),
          detail: t("filingStuckWhy", { reason: t(`filingReason_${f.reason ?? "unknown"}`) }),
          link: settings,
        };
      }

      /* WAITING. Calm, and NOT busy: nothing is in flight — the row is asleep until its retry.
       * A spinner over a scheduled wait is the animation-implies-progress lie one arm up. */
      if (f?.arm === "waiting") {
        return {
          tone: "", role: "status", warn: false, busy: false,
          title: t("filingWaiting", { count: f.count }),
          detail: t("filingWaitingWhy", {
            reason: t(`filingReason_${f.reason ?? "unknown"}`),
            // An unparseable or absent instant becomes an em dash rather than "Invalid Date" or
            // a dropped placeholder: the sentence still says a retry is scheduled, which is the
            // true part, and the clause that cannot be filled reads as missing.
            at: (f.nextAttemptAt && clockTime(f.nextAttemptAt)) || "—",
          }),
          link: settings,
        };
      }

      return {
        // BUSY, not `warn`. Nothing has failed: the API files by writing `folder_state` and the
        // worker applies it on its next cycle, so a backlog is the ordinary shape of that
        // handoff and only becomes a problem if it stops draining. A warning triangle over a
        // normal few seconds would train people to ignore the one that matters.
        tone: "busy", role: "status", warn: false, busy: true,
        // "On your mail server" is the load-bearing half of the sentence. The mail HAS moved in
        // ohmail — the user watched it — so a bare "Filing 12 messages" reads as a lie about
        // something they can see is already done. What is outstanding is the copy of that
        // decision on their own IMAP host.
        title: t("filing", { count: state.pending }),
        // THE LAST PASS is what separates a turn from a stall, and it is preferred over the
        // address line when both are available: which mailbox it is matters less than whether
        // anything is running. Absent (no heartbeat — every local tier) the line falls back to
        // the address, and absent that too there is no second line, which is the honest shape
        // for a build that can only report the count.
        detail: f?.lastPassSeconds !== null && f?.lastPassSeconds !== undefined && asOf
          ? t("filingPass", {
              ago: f.lastPassSeconds < 90
                ? t("filingPassSeconds", { seconds: f.lastPassSeconds })
                : t("filingPassMinutes", { minutes: Math.floor(f.lastPassSeconds / 60) }),
              at: asOf,
            })
          : where,
        // THE RETRY AFFORDANCE. If the host is refusing connections this does not drain on its
        // own, and Settings → Mailboxes is where the mailbox's own state and its reconnect live.
        // The link is the difference between a sentence a person can act on and one they can
        // only watch.
        link: settings,
      };
    }

    case "noMailbox":
      // Reachable only when `GET /mailboxes` ANSWERED and answered zero. A probe that failed
      // leaves the facts unknown and this strip silent — see `MailStateProvider`.
      return { tone: "", role: "status", warn: false, busy: false, title: t("noMailbox"), detail: null, link: settings };

    case "importing": {
      const counted = state.total !== null
        ? t("importingOf", { count: state.count, total: state.total })
        : t("importingCount", { count: state.count });
      // WHERE THE FIRST SYNC IS CONTINUING (mail 0115). A first sync of a mailbox with many large
      // folders runs in bounded passes: the count stepped, then sat still, and nothing said why.
      // The clause is appended to the count rather than given its own line, because it is the
      // same fact — how far along this is — and `mail-state.ts` withholds the folder unless
      // exactly one mailbox names one.
      const detail = state.continuesAtFolder === null
        ? counted
        : `${counted} · ${t("importingContinuesAt", { folder: state.continuesAtFolder })}`;
      return {
        tone: "busy", role: "status", warn: false, busy: true,
        // "Syncing", not "Importing your mailbox". The client can see its own mirror growing;
        // it cannot see a worker, so a sentence that claims one is asserting something this
        // code does not know. The count is the largest TRUE thing here.
        title: t("importing"),
        // Never a percentage, and that rule is untouched by the arrival of a denominator: what
        // `state.total` carries is the ACCOUNT's message count, measured by the server on its own
        // clock, not a share of a drain `/sync` could report. When it is present the pair is
        // quoted as two numbers, "N of M"; when it is absent — every hosted browser tab,
        // by design — the moving count alone is what distinguishes working from hung, exactly as
        // before. `mail-state.ts` withholds the total unless it is strictly above the count, so
        // this line can never render a fraction that has already been passed.
        detail,
        // ONE derivation for both faces: the line a person reads and the sentence a person hears
        // are the same string, so no wording change can reach one and miss the other.
        say: `${t("importing")} ${detail}`,
        progress: state.total !== null ? state.count / state.total : null,
        link: null,
      };
    }

    default:
      // `awaiting` — connected, no cycle has completed, and the mirror is empty. Often the
      // CORRECT thing to say: a first attach was measured at ~6 minutes. What was wrong before
      // was saying it alone, for ever, with no elapsed time and while the mirror grew.
      return {
        tone: "busy", role: "status", warn: false, busy: true,
        // Two sentences rather than one with a clause: "a first sync takes a few minutes" is
        // true and useful at four minutes and misleading at forty. The escalated one drops the
        // explanation and states the elapsed time — and claims no failure, because at this
        // point nothing has failed.
        title: state.slow ? t("awaitingSlow") : t("awaiting"),
        detail: state.address
          ? t("awaitingWhere", { address: displayAddress(state.address), minutes: state.minutes ?? 0 })
          : t("awaitingFor", { minutes: state.minutes ?? 0 }),
        link: state.slow ? settings : null,
      };
  }
}

/**
 * The strip's leading mark — an envelope, a warning, or, while a drain is in flight, a spinner. `importing` and
 * `awaiting` report WORK and can sit for minutes, and while that work is running the spinner is the one element
 * continuously true: a process is running, with no claim about how far along. Between drains it is UNMOUNTED rather
 * than stilled, because a mark that is present and not moving is a second way of saying nothing that costs frames to
 * say. Indeterminate on purpose, even now that a total exists: `/sync` answers `hasMore` as a boolean, so the shape
 * of the drain is unknowable from the loop; {@link MailState.total} is a different fact measured at a different
 * moment. Two numbers may be quoted side by side — "N of M" reads as two measurements — but never turned into one
 * percentage or filled track, which claims a continuous progression the client cannot see.
 */

/**
 * `mbx-spin` is a class the Settings rows own, reused deliberately: `(product)/mailbox/MailboxSection.tsx:428`
 * already renders this exact spinner for this exact fact, so styling a second one would be two spellings of one
 * event. It is layout-independent (a fixed 11 px ring, `--hair`/`--accent`), and its `prefers-reduced-motion` answer
 * exists at `app.css:1657`: the ring stays, the rotation stops. The class NAME is the only wart — `mbx-` means the
 * Settings block; renaming to a shared `.spin` is a change to `app.css`, and is owed. `aria-hidden` on all three
 * forms: the strip is a `role="status"` region that already announces its sentence, and an indeterminate spinner has
 * no value a screen reader could report.
 */
function Glyph({ warn = false, busy = false }: { warn?: boolean; busy?: boolean }) {
  if (busy) return <Spinner className="mbx-spin" />;
  return (
    <span className="glyph" aria-hidden="true">
      {warn ? "⚠" : "✉"}
    </span>
  );
}

/**
 * How long a block has been in force.
 *
 * Minutes below an hour and hours above it, as two keys rather than one — "Since 187 minutes
 * ago" is a true sentence nobody can read, and an organizer lease that cannot be read stays
 * unreadable for as long as the server stays broken. Rendered only once there is a whole minute
 * to report: `syncBlockedSince` is written after the 120 s grace, so a zero here means the
 * clock and the row disagree by a beat, and "Since 0 minutes ago" is worse than silence.
 */
function Since({
  minutes,
  t,
}: {
  minutes: number | null;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  if (minutes === null || minutes < 1) return null;
  return (
    <>
      {" · "}
      {minutes < 60
        ? t("sinceMinutes", { minutes })
        : t("sinceHours", { hours: Math.floor(minutes / 60) })}
    </>
  );
}
