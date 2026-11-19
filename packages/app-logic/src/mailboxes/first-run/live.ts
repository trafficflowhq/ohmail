/**
 * THE FIRST RUN'S FACTS, LIVE: what the stage's model reads of the ground (`FirstRunGround`), assembled from the
 * ground's readers and the engine while the stage stands. The stage's seat calls it once a render; nothing of a shell
 * is read. Every reader here throws where the ground does not stand: a first run is never drawn over a guess.
 *
 * NOTHING IS DRAWN BEFORE BOTH ANSWERS: the rows are `null` until the account's mailboxes were read AND its consent
 * row answered by the live read. Both rest as "nothing has happened yet", and a setup drawn over a resting value would
 * stand over the mail of an account that finished it long ago. A boot cache is no answer: the device's cached row
 * carries neither the window's scope nor the stamp of setup, so a run drawn over it would offer, and store, a window
 * the person never chose.
 *
 * WHICH MAILBOX THE RUN IS ABOUT is the address's claim, answered by the account's own rows with the model's rule
 * (`subjectOf`). The one fact that is a hook's, the pull held for the store's answer about the Screener's queue, is
 * kept for that mailbox; a question about any other mailbox is refused, never answered with an empty record.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useCallback, useMemo } from "react";
import { firstContactTime, notifiedSenderName } from "@ohmail/client-engine";
import { useConsent } from "../../consent/consent-row.js";
import { usePartition } from "../../consent/partition.js";
import { firstRunImportOver, useFirstRunQueueSettle } from "../../doors/first-run-queue-settle.js";
import { accountOrganizer, firstRunCounts, screenerForMailbox } from "../../doors/first-run-subject.js";
import { importOverOf } from "../../doors/onboarding.js";
import { useEngine } from "../../engine/context.js";
import type { PlaceLiveArgs } from "../../lists/place-live.js";
import { useMailState } from "../../mail-state/mail-state-binding.js";
import { liveMailboxes, serverUnreachable, type MailboxFacts } from "../../mail-state/mail-state.js";
import { usePresented } from "../../reading/presented-mirror.js";
import type { ScreenerState } from "../../screener/screener-state.js";
import { mailboxIdOfAnswer, subjectOf } from "../connect/subject.js";
import type { MailboxId } from "../connect/types.js";
import { markDecisionAsked } from "./decision-asked.js";
import type { FirstRunAbout, FirstRunGround, FirstRunRow, FirstRunSender } from "./ground.js";

/** What only the stage's seat can read: the run's words off the address, the Screener's one model, its words, a date. */
export interface FirstRunLiveOwn {
  /** Which first run the address names: a first run, a re-run or an add. */
  readonly how: "run" | "again" | "add";
  /** The mailbox the address names, as it is written there: a claim until a row answers it. */
  readonly word: string | null;
  /** The frame's one Screener model: who waits, the count the rail draws, and the decision itself. */
  readonly screener: Pick<ScreenerState, "waiting" | "waitingCount" | "decide">;
  /** The Screener's own words for the card of the guided decision. */
  readonly words: {
    /** What stands beside a name that claims a company its address is not. */
    notBrand(brand: string): string;
    /** The caption of a sender's waiting letters: how many, and since when where a first contact stands apart. */
    held(count: number, firstContact: string | undefined): string;
  };
  /** An instant as a date in the reader's language and zone, or `null` where it names none. */
  dateOf(instant: string | null | undefined): string | null;
}

/** One row of the mail state as the run reads it. Absent and `null` are different answers: both are handed on. */
function rowOf(
  m: MailboxFacts,
  dateOf: FirstRunLiveOwn["dateOf"],
  stripOver: boolean | undefined,
): FirstRunRow | null {
  /* An id is minted in one place; a row whose id is none is no row of a run. */
  const id = mailboxIdOfAnswer(m.id);
  if (id === null) return null;
  const since = dateOf(m.organizedBy?.since);
  return {
    id,
    address: m.address,
    organizerRole: m.organizerRole,
    organizedBy: m.organizedBy,
    organizerState: m.organizerState,
    organizerEventAt: m.organizerEventAt,
    takeoverAuthorizedAt: m.takeoverAuthorizedAt,
    organizerChecked: m.organizerChecked,
    unreachable: serverUnreachable(m),
    organizeConsentedAt: m.organizeConsentedAt,
    initialImportCompletedAt: m.initialImportCompletedAt,
    importOver: stripOver,
    serverMessageCount: m.serverMessageCount,
    ...(since === null ? {} : { holderSince: since }),
  };
}

export function useFirstRunLive(args: PlaceLiveArgs, own: FirstRunLiveOwn): FirstRunGround {
  const engine = useEngine();
  const { mailboxes, refresh, pulled, importOver } = useMailState(); // throws where no ground stands above
  const consent = useConsent(); // throws where no ground stands above
  const { consentView } = usePartition(); // throws where no ground stands above
  const presented = usePresented(); // throws where no ground stands above
  const { how, word, screener, words, dateOf } = own;
  const held = args.press.deleting.held;
  const scope = args.scope;

  const facts = useMemo(() => liveMailboxes(mailboxes), [mailboxes]);
  /* The rows as the strip reads each import's end; the run's own row is narrowed below. */
  const read = useMemo(
    () =>
      facts === null || !consent.known || !consent.onboardingKnown
        ? null
        : facts.flatMap((m) => rowOf(m, dateOf, importOver.get(m.id)) ?? []),
    [facts, consent.known, consent.onboardingKnown, importOver, dateOf],
  );
  const subject = subjectOf(read, word, how === "add" ? "add" : "run").mailbox;
  const subjectId: MailboxId | null = subject?.id ?? null;
  const rereadQueue = useCallback(() => engine.refreshScreenerWaiting(), [engine]);
  /* The pull waits for the store's answer about the Screener's queue once this mailbox's import ends. */
  const settling = useFirstRunQueueSettle({
    active: true,
    mailboxId: subjectId,
    over: subject !== null && importOverOf(subject),
    reread: rereadQueue,
  });
  const rows = useMemo(
    () =>
      read === null || !settling
        ? read
        : read.map((row) =>
            row.id === subjectId ? { ...row, importOver: firstRunImportOver(row.importOver, true) } : row,
          ),
    [read, settling, subjectId],
  );

  const many = (facts?.length ?? 0) > 1;
  /* The run's own queue: the senders whose letters wait in this mailbox, and only those a decision can be made of. */
  const queue = useMemo(
    () =>
      screenerForMailbox(
        screener.waiting.filter((row) => !("pinned" in row)),
        (id) => presented.get<EngineMessage>("message", id)?.mailboxId,
        subjectId,
        many,
      ),
    [screener.waiting, presented, subjectId, many],
  );
  /* What this device holds of the mailbox, in the two parts the screens name. History is the partition's own list,
     without what stands inside a delete's Undo window, as every list is drawn. */
  const counts = useMemo(() => {
    const history = (consentView?.history ?? []).filter((m) => !held.has(m.id));
    return firstRunCounts(presented.list<EngineMessage>("message"), history, subjectId);
  }, [presented, consentView, held, subjectId]);
  const whole = engine.storeCoverage().state === "whole";
  const head = queue[0];
  const { waitingCount, decide } = screener;
  const sender = useMemo((): FirstRunSender | null => {
    if (head === undefined) return null;
    return {
      name: notifiedSenderName(head, words.notBrand),
      address: head.from.address,
      held: head.held.length,
      /* The rail's own count: the step and the rail never say two numbers. */
      waiting: waitingCount,
      many,
      since: words.held(head.held.length, firstContactTime(head)),
      /* The Screener's own decision, the one a press in the Screener makes a minute later. */
      decide: (to, opts) => decide(head, to, { read: opts.markRead, scope: opts.scope }),
    };
  }, [head, waitingCount, many, decide, words]);
  const about = useMemo(
    (): FirstRunAbout => ({
      /* The count and the card come from one list; on one mailbox the Screener's own count is the sharper one. */
      queuedSenders: many ? queue.length : waitingCount,
      pull: { ...counts, pulled, whole },
      sender,
      queueSettling: settling,
      rereadQueue,
    }),
    [many, queue.length, waitingCount, counts, pulled, whole, sender, settling, rereadQueue],
  );

  const account = useMemo(
    () => ({ onboardingCompletedAt: consent.onboardingCompletedAt }),
    [consent.onboardingCompletedAt],
  );
  /* What the account stored of the window, only where an answer is stored: the baseline is written by the consent
     itself and by the first decision, and rests null. A resting window is the product's default, never a choice. */
  const stored = consent.screeningBaselineAt !== null;
  const screening = useMemo(
    () => (stored ? { dormancyDays: consent.dormancyDays, scope: consent.screeningScope } : undefined),
    [stored, consent.dormancyDays, consent.screeningScope],
  );
  const organizer = useMemo(() => accountOrganizer(facts), [facts]);
  /* A drawn step marks this account's launch as asked, never that of another account signed in in the same tab. */
  const drawn = useCallback(() => markDecisionAsked(scope), [scope]);

  return useMemo(
    (): FirstRunGround => ({
      rows,
      account,
      ...(screening === undefined ? {} : { screening }),
      accountOrganizer: organizer,
      about: (mailboxId) => {
        if (mailboxId !== subjectId)
          throw new Error("useFirstRunLive: asked about a mailbox the run is not about");
        return about;
      },
      refresh,
      drawn,
    }),
    [rows, account, screening, organizer, about, subjectId, refresh, drawn],
  );
}
