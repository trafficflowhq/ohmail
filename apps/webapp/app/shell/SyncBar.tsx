"use client";

/**
 * THE SHELL'S SYNC STRIP — everything the product has to say about a sync, said wherever you
 * are standing.
 *
 * ── WHAT WAS WRONG THE FIRST TIME ───────────────────────────────────────────────────────
 *
 * "Sync failed. Retrying." existed, and it rendered in exactly one place: the Ohbox's EMPTY
 * state. So the only mailbox that could ever be told its sync was broken was one that had
 * never loaded anything — and the mailbox that most needs telling is the opposite of that.
 * A list with four hundred rows in it whose drains have been failing for ten minutes looked
 * completely healthy: the rows were there, they were just from ten minutes ago, and nothing
 * anywhere said so. Reads, Receipts and the Screener had no failure surface at all.
 *
 * It has been found three separate times, because each time the fix was written as another
 * branch inside a view — and a view can only speak about itself.
 *
 * ── AND THE SAME WAS TRUE OF PROGRESS ───────────────────────────────────────────────────
 *
 * The failure had a home; the FIRST IMPORT did not. `mailboxes.syncPending` — "Waiting for
 * first sync" — was one sentence for every state a first sync can be in, and it lived on a row
 * in Settings → Mailboxes, three clicks from where anybody was looking — and a first import
 * runs for tens of minutes, not seconds, on a mailbox of any size. The Ohbox's own
 * counter existed but stopped at `bootstrapping`, which goes false as soon as the first CLIENT
 * drain lands — seconds — so it was silent for the entire multi-minute WORKER import that
 * follows.
 *
 * So the strip renders the whole ladder in `mail-state.ts`, and this file decides NOTHING: it
 * is a switch over a key somebody else derived. That is the actual repair. A view cannot forget
 * it, the next view added gets it for free, and a seventh state cannot be invented here because
 * there is nowhere here to invent one.
 *
 * ── WHY A SHELL STRIP AND NOT A PER-VIEW BANNER ─────────────────────────────────────────
 *
 * Three properties the gap asks for, and one placement that has all three:
 *
 *  1. **Every view, including the ones nobody thought of.** Rendered once, by the shell,
 *     above the deck.
 *  2. **It cannot scroll away.** It is a `flex: none` row of `.shell`, a sibling of the
 *     deck, so it is outside every list's scroller by construction rather than by a
 *     `position: sticky` that a future overflow context could break.
 *  3. **Silent when healthy.** `quiet` renders `null`, so there is no permanent "everything
 *     is fine" chrome to learn to ignore. The demo and the Desktop are gated to `quiet` in the
 *     derivation and have no mailbox probe either, so they never render it at all.
 *
 * Above the mobile topbar rather than below it: the topbar is the current view's title, and
 * this is not about the current view.
 *
 * ── RETRYING IS NOT STOPPED ─────────────────────────────────────────────────────────────
 *
 * `terminal` means the server refused this session in a way no waiting fixes — a 401 or
 * 403, a revoked session, a deleted account — and the loop has stopped. Rendering "Retrying."
 * for that would be a false statement about what the app is doing, so it gets its own line
 * and the one remedy that exists. Everything else is genuinely still being retried, forever,
 * at up to a minute apart, and says so.
 *
 * ── WHY THE COUNT IS NOT ANNOUNCED, AND NOT HIDDEN EITHER ───────────────────────────────
 *
 * `importing`'s count climbs on every drain — up to once every eight seconds, for minutes.
 * Inside a `role="status"` region that is a screen reader reading out a new number seven times
 * a minute, which is not information; it is noise that makes the app unusable to listen to.
 * The existing strip got away with `aria-live="polite"` only because its text is CONSTANT.
 *
 * So each sentence is split. The stable half is live and announces once when the strip appears;
 * the volatile half carries `aria-live="off"`, which suppresses announcements for changes to
 * that node while leaving the text present and readable by browsing. Deliberately NOT
 * `aria-hidden`: the count is the information, and removing it from the accessibility tree
 * would be a second defect dressed as a fix for the first.
 */
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { apiConfigured } from "../api-client";
import { useMailState } from "./MailStateProvider";
import { stripSpeaks, type MailState } from "./mail-state";

/**
 * ── AND WHY IT IS RENDERED TWICE, IN TWO SHAPES ─────────────────────────────────────────
 *
 * The strip's placement above the deck was right about WHOSE chrome this is and wrong about
 * where that chrome lives now. The rail already carries everything that acts on the app rather
 * than on mail — the palette, the theme, the account — so a line about the mailbox belongs at
 * the foot of it, not across the top of somebody's reading. The `busy` states were worse still:
 * a pill floating over the bottom-left corner of every view, which is chrome ON the mail.
 *
 * So the shell renders `variant="rail"` into the rail's own slot and keeps `variant="shell"`
 * where it always was, and `app.css` shows exactly one of them: the rail form wherever the rail
 * is standing, the strip and the corner pill wherever it is not (under 900px the rail collapses
 * into a drawer, and a sync line inside a closed drawer is a sync line nobody is told about).
 *
 * `display:none` and not a JS width test, deliberately. The hidden copy leaves the accessibility
 * tree with it, so two `role="status"` regions never announce the same sentence twice, and there
 * is no render that disagrees with the media query it is trying to predict.
 *
 * ── ONE DESCRIPTION, TWO RENDERERS ──────────────────────────────────────────────────────
 *
 * `speech()` below is the switch this file used to BE. Both shapes read it, so the sentence, the
 * tone and the remedy for a given state are decided once. Two independent switches over the same
 * seven states is the drift this file's header spends forty lines arguing against, and adding a
 * second placement would have been the exact way to reintroduce it.
 */
/* No default VALUE on the parameter, only on the field. A `= {}` there types the component as
   `(props?: …)`, which is not a `FunctionComponent<P>`, and `createElement(SyncBar, { variant })`
   then resolves to the propless overload and rejects the prop it was given. */
export function SyncBar({ variant = "shell" }: { variant?: "shell" | "rail" }) {
  const t = useTranslations("sync");
  // The error TAXONOMY lives with the Settings rows that already own it (`mailboxes.err_*`,
  // mail 0023). Two copies of seven sentences is how they drift, and one of them then describes
  // a failure mode the other has renamed.
  const tm = useTranslations("mailboxes");
  const { state } = useMailState();

  if (!stripSpeaks(state.key)) return null;
  // WHICH DOOR this install came in by. `apiConfigured()` is false exactly on the build with no
  // Cloud behind it — the standalone desktop, which folds `NEXT_PUBLIC_API_BASE` away at build
  // time — so it is the seam the `stopped` sentence branches on. See `speech()`'s `stopped` arm.
  const cloud = apiConfigured();
  const s = speech(state, t, tm, cloud);

  if (variant === "rail") {
    return (
      <div
        className={s.tone ? `rail-sync ${s.tone}` : "rail-sync"}
        role={s.role}
        aria-live={s.role === "status" ? "polite" : undefined}
      >
        <div className="rs-line">
          <Glyph warn={s.warn} busy={s.busy} />
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
            percentage would be invented. A travelling sliver says a process is running and
            claims nothing about how far along it is — the same knowledge the spinner carries,
            in the shape a compact row has space for. `aria-hidden`: the region already says it
            in words. `prefers-reduced-motion` stops the travel and leaves the track (app.css). */}
        {s.busy ? (
          <span className="rs-track" aria-hidden="true">
            <i />
          </span>
        ) : null}
        {s.link ? <a href={s.link.href}>{s.link.label}</a> : null}
      </div>
    );
  }

  return (
    <div
      className={s.tone ? `sync-bar ${s.tone}` : "sync-bar"}
      role={s.role}
      aria-live={s.role === "status" ? "polite" : undefined}
    >
      <Glyph warn={s.warn} busy={s.busy} />
      <b>{s.title}</b>
      {s.detail ? (
        <span className="num" aria-live="off">
          {s.detail}
        </span>
      ) : null}
      {s.link ? <a href={s.link.href}>{s.link.label}</a> : null}
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
  /** The volatile half — a climbing count, an elapsed minute, an address. Never announced. */
  detail: ReactNode | null;
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

    case "failing":
      // Polite, and deliberately not re-announced: the text is constant for as long as the
      // outage lasts, so the region updates once when it appears and once when it goes.
      return { tone: "", role: "status", warn: true, busy: false, title: t("failing"), detail: null, link: null };

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
            {state.address}
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
        detail: state.address,
        link: settings,
      };

    case "filing":
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
        detail: state.address ? t("filingWhere", { address: state.address }) : null,
        // THE RETRY AFFORDANCE. If the host is refusing connections this does not drain on its
        // own, and Settings → Mailboxes is where the mailbox's own state and its reconnect live.
        // The link is the difference between a sentence a person can act on and one they can
        // only watch.
        link: settings,
      };

    case "noMailbox":
      // Reachable only when `GET /mailboxes` ANSWERED and answered zero. A probe that failed
      // leaves the facts unknown and this strip silent — see `MailStateProvider`.
      return { tone: "", role: "status", warn: false, busy: false, title: t("noMailbox"), detail: null, link: settings };

    case "importing":
      return {
        tone: "busy", role: "status", warn: false, busy: true,
        // "Syncing", not "Importing your mailbox". The client can see its own mirror growing;
        // it cannot see a worker, so a sentence that claims one is asserting something this
        // code does not know. The count is the largest TRUE thing here.
        title: t("importing"),
        // Never a percentage: `/sync` answers `hasMore` as a boolean, so the TOTAL is unknowable
        // until the drain ends. A count is available, and it MOVES, which is the part that
        // distinguishes working from hung.
        detail: t("importingCount", { count: state.count }),
        link: null,
      };

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
          ? t("awaitingWhere", { address: state.address, minutes: state.minutes ?? 0 })
          : t("awaitingFor", { minutes: state.minutes ?? 0 }),
        link: state.slow ? settings : null,
      };
  }
}

/**
 * The strip's leading mark — an envelope, a warning, or, while work is genuinely in flight,
 * a spinner.
 *
 * ── WHY THE BUSY STATES GET A SPINNER AND NOT AN ENVELOPE ───────────────────────────────
 *
 * `importing` and `awaiting` are the two states that report WORK, and both can sit for
 * minutes. A static ✉ beside a number that changes once every eight seconds reads as a frozen
 * screen — reported from live use on a full mailbox — because between drains
 * nothing on the strip moves at all. The spinner is the one element here that is continuously
 * true: it says a process is running without claiming to know how far along it is.
 *
 * INDETERMINATE ON PURPOSE. `/sync` answers `hasMore` as a boolean, so the TOTAL is unknowable
 * until the drain ends; a percentage or a filled track would be invented, and this strip does
 * not invent. A spinner is the affordance that carries exactly the knowledge available.
 *
 * ── WHY `mbx-spin`, A CLASS THE SETTINGS ROWS OWN ───────────────────────────────────────
 *
 * Deliberate reuse. `(product)/mailbox/MailboxSection.tsx:428` already renders this exact
 * spinner for this exact fact — "this mailbox is syncing" — so styling a second one here would
 * be two spellings of one event, the drift this file's own header argues against. It is
 * layout-independent (a fixed 11 px ring), built from `--hair`/`--accent`, and its
 * `prefers-reduced-motion` answer already exists at `app.css:1657`: the ring stays, the
 * rotation stops, so the affordance survives without motion. The class NAME is the only wart —
 * `mbx-` means the Settings block. It wants renaming to a shared `.spin`, which is a change to
 * `app.css`, and is owed.
 *
 * `aria-hidden` on all three forms. The strip is a `role="status"` region that already
 * announces its sentence, and an indeterminate spinner has no value a screen reader could
 * report; announcing it would add noise, not information.
 */
function Glyph({ warn = false, busy = false }: { warn?: boolean; busy?: boolean }) {
  if (busy) return <span className="mbx-spin" aria-hidden="true" />;
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
