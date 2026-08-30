/**
 * WHAT IS HAPPENING TO MY MAIL, SAID IN SIX WAYS INSTEAD OF ONE WRONG WAY.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * The product had exactly ONE sentence for every state a first sync can be in:
 * `mailboxes.syncPending`, "Waiting for first sync", rendered by a spinner in Settings →
 * Mailboxes whenever `lastSyncAt` was null. Observed on a real first import: it stayed on
 * screen for half an hour while hundreds of messages arrived, and was still climbing when it
 * was checked. It is not merely unhelpful — it is the only
 * thing the product says during the period in which it is working hardest, and it kept
 * saying it after mail WAS flowing.
 *
 * ── WHY `lastSyncAt` CANNOT BE THE PROGRESS SIGNAL, IN EITHER DIRECTION ─────────────────
 *
 * Two things were read out of the worker rather than assumed, and each one on its own
 * disqualifies the column:
 *
 *  · **It is shared.** The server stamps it in ONE `UPDATE … WHERE id IN (…)` covering every
 *    mailbox the cycle served. Two mailboxes on one account were measured reporting an
 *    IDENTICAL 207 seconds of age, so the column cannot distinguish one mailbox's progress
 *    from another's.
 *  · **It lands EARLY.** The server moves a mailbox into `synced` after each successful cycle
 *    *whether or not* it still has a backlog. So a mailbox thirty seconds into a thirty-minute
 *    import already carries a stamp.
 *
 * And separately it lands LATE: the first attach has been measured at around six minutes,
 * twice, on a mailbox of a few thousand messages, and attaches are serial — so a second
 * mailbox legitimately waits behind the first with a null stamp the whole time.
 *
 * **Therefore the growing state keys on THE MIRROR GROWING — the client's own message count
 * rising across syncs.** It does NOT read `lastSyncAt` as a progress signal, in either direction:
 * that column is consulted in exactly one place ({@link deriveMailState}'s `awaiting` arm) and only
 * as `=== null`, the one reading the two defects above leave intact — only ids in `synced` are ever
 * stamped, so a null really does mean "not one cycle has completed for this mailbox yet". The
 * POSITIVE reading — "this mailbox synced 207 seconds ago" — is the worthless one, and it is
 * never taken.
 *
 * ── THE ONE STAMP THAT IS SOUND TO READ, AND WHY ────────────────────────────────────────
 *
 * The mirror-growth signal is BLIND at the edges of an import: a first import is drained
 * newest-first in bounded batches, so the server holds a PARTIAL mailbox for minutes, and a tab
 * that catches up to that partial state — or opens onto it after the growth run has lapsed — sees
 * a settled mirror and cannot tell "finished" from "not finished, but this client has stopped
 * observing progress". No client fact distinguishes them; only the server knows.
 *
 * So there is a SECOND stamp, `initial_import_completed_at`, and it is read as a FLOOR: while a
 * connected mailbox has not been stamped, `importing` speaks regardless of the mirror. It is the
 * stamp `lastSyncAt` could not be — PER-MAILBOX rather than shared, and LATE (written only once a
 * cycle drains with `hasBacklog === false`) rather than early — so the two defects that make
 * `lastSyncAt` worthless do not touch it. It is still read only as `=== null` ("not known to be
 * finished"), never positively, and a MISSING field (a server that predates the column) reads as
 * `undefined`, not `=== null`, so a deploy skew degrades to growth-only rather than a false import.
 * The line "reads no server timestamp" that used to stand here was true of the growth signal and
 * is why the floor is a SEPARATE arm from {@link isImporting} rather than a third case inside it.
 *
 * ── AND THE FLOOR IS BOUNDED, BECAUSE "NOT KNOWN TO BE FINISHED" IS NOT "IN PROGRESS" ───
 *
 * That floor was unconditional as first written, and the sentence above — "speaks regardless of the
 * mirror" — was true without limit. It cost a permanent falsehood. Nothing obliges the worker ever
 * to reach a no-backlog cycle, and a mailbox was observed going four days without one while
 * `connected` and syncing normally, so the strip reported an import in progress for ever over a
 * mirror that was complete, current and readable — and because the arm uses `some`, that one
 * mailbox spoke for a second, properly stamped one beside it.
 *
 * A null stamp is an UNKNOWN, and this module's founding argument — that a column which cannot bear
 * a positive reading must not be given one — applies to this stamp exactly as it applies to
 * `lastSyncAt`. So the floor is obeyed absolutely for {@link IMPORT_FLOOR_MAX_MS} after a mailbox is
 * connected, which covers every import anyone has measured, and past that it must be CORROBORATED
 * by facts this client owns: a completed drain, a loop with no failures, and a mirror that has not
 * moved. {@link importFloorSpeaks} is the whole of it, and it is deliberately not a third case
 * inside {@link isImporting}: the growth arm still reads no server timestamp at all.
 *
 * ── WHY THE DERIVATION IS HERE AND NOT IN A VIEW ────────────────────────────────────────
 *
 * `SyncBar.tsx` records that the failure sentence was found three times, because each fix
 * was written as another branch inside a view and a view can only speak about itself. This
 * module is the same lesson applied to the progress sentence: ONE pure function, no React, no
 * DOM, no network, run ONCE per shell. Three surfaces render its answer — the shell's strip,
 * the Ohbox's empty pane and the Settings → Mailboxes rows — and not one of them decides
 * anything. A fourth surface added later gets the same answer for free.
 *
 * The growth sampler is STATEFUL, which is the other half of "run once": two consumers each
 * running their own sampler could disagree about whether the mirror is growing, which is this
 * bug again with extra steps.
 */

/* ══════════════════════════════════════════════════════════════════════════════════════════
   WHAT THE CLIENT CAN ACTUALLY OBSERVE
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The ways OUR OWN infrastructure declines to serve a mailbox (mail 0029).
 *
 * A CLOSED set with a CHECK constraint behind it, owned server-side as
 * `MAILBOX_SYNC_BLOCK_REASONS`. It is re-declared here rather than imported for the same reason
 * `api-client.ts` re-declares `errorCode`: this module ships in the Desktop app, which is built
 * without the server packages, so an import would break a build that has no server in it at all.
 *
 * Re-declaring a closed set is how the two drift, and it has produced a failure once already: a fourth `status` value would have rendered the literal key path
 * `status_xxx` in the product. Two things stop that here. `test/mail-state.test.ts` asserts, FROM
 * `@trafficflow/db`, that this array and that one are the same array and that `en.json`
 * carries a sentence for every member — so drift is a red test. And at RUNTIME an unrecognised
 * reason still produces the `blocked` state with generic copy (see {@link deriveMailState}),
 * because a server that grows a fourth reason must not be answered with silence.
 */
export const SYNC_BLOCK_REASONS = [
  "lease_unreadable",
  "awaiting_credentials",
  "at_capacity",
] as const;
export type SyncBlockReason = (typeof SYNC_BLOCK_REASONS)[number];

export function isSyncBlockReason(v: unknown): v is SyncBlockReason {
  return typeof v === "string" && (SYNC_BLOCK_REASONS as readonly string[]).includes(v);
}

/**
 * THE ORGANIZER LEASE'S VERDICT, AS COPY TOKENS.
 *
 * `mailboxes.disabled_reason` is the other closed set on this row: `MAILBOX_DISABLED_REASONS`,
 * three members, its own CHECK constraint, owned server-side. It says why a
 * mailbox is `disabled` when the LEASE decided it rather than a person — and it used to be on
 * no wire at all, which is how a mailbox could read "disconnected", "No mail yet — added 3
 * minutes ago" and "No mailbox connected, so nothing can arrive" at the same moment.
 *
 * ── THE VALUES HERE ARE NOT THE WIRE'S VALUES, AND THAT IS DELIBERATE ───────────────────
 *
 * The wire tokens carry a colon (`organized_elsewhere:local`). {@link MailState.reason} is
 * documented as COPY — `SyncBar` interpolates it straight into `t(\`blocked_${reason}\`)` — so
 * whatever lands in that field becomes an i18n key. Mapping here keeps a SERVER-OWNED string out
 * of the message namespace entirely, which is a stronger guarantee than "a colon happens to
 * resolve" (it does; that was measured before this map replaced it). {@link standDownToken} is
 * the only place the two vocabularies meet, and `test/mailbox-stand-down.test.tsx` reconciles this
 * table against `MAILBOX_DISABLED_REASONS` read out of the owning module — the same guard
 * `SYNC_BLOCK_REASONS` already carries, for the same drift.
 */
export const STAND_DOWN_REASONS = [
  "organized_elsewhere_cloud",
  "organized_elsewhere_local",
  "organized_elsewhere_unknown",
] as const;
export type StandDownReason = (typeof STAND_DOWN_REASONS)[number];

/**
 * A `disabled_reason` off the wire, as the copy token for it.
 *
 * `null` in, `null` out — that is the ORDINARY DISCONNECT and it must stay distinguishable, or
 * a mailbox the user removed on purpose gets told another install has claimed it.
 *
 * Anything else in, `organized_elsewhere_unknown` out. The server already narrows an
 * unrecognised member to `:unknown` on the way out (`mailbox-service.ts`), so this is the second
 * line rather than the first — but it is the line that matters during a deploy, and answering a
 * member this build has never heard of with `null` would file a newer worker's stand-down as
 * "the user disconnected this" — a mistake this codebase has made once already, transposed onto
 * a column with no timestamp beside it. That is why this function never returns `null` for a non-null input.
 */
export function standDownToken(wire: string | null): StandDownReason | null {
  if (wire === null) return null;
  if (wire === "organized_elsewhere:cloud") return "organized_elsewhere_cloud";
  if (wire === "organized_elsewhere:local") return "organized_elsewhere_local";
  return "organized_elsewhere_unknown";
}

/**
 * ONE mailbox, as the shared shell is allowed to know it.
 *
 * Structural and shell-owned, NOT `MailboxDTO`. The Cloud client's API layer is not part of the
 * Desktop app, so this file may not name its types; and narrowing to the fields the
 * ladder reads is the honest declaration of what the derivation is entitled to consult.
 * Anything the Cloud client can see and this interface does not name is a fact the copy may
 * not assert.
 */
export interface MailboxFacts {
  /**
   * WHICH mailbox this is — added for the From seam, NOT for the ladder.
   *
   * `deriveMailState` must never read it, and does not: every state below is about the account
   * or about one mailbox already in hand, and an id is not a fact any sentence can assert. It
   * is here because `compose-from.ts` needs a stable, non-address handle — the From selector's
   * value is a mailbox id and never an address string, so that an alias landing later cannot
   * turn one address into two mailboxes' worth of ambiguity.
   */
  id: string;
  address: string;
  /**
   * The mailbox's user-facing label from `GET /mailboxes` — what the "me" recipient chip wears
   * as the account's name (viewer redesign). `deriveMailState` must never read it, and does not: a
   * label says nothing about whether mail is arriving. OPTIONAL and nullable because the wire
   * is (`MailboxDTO.displayName` — OAuth connects fill it from the provider, IMAP connects only
   * when the user typed one), and the chip's fallback for both absences is the bare address.
   */
  displayName?: string | null;
  /** The 3-member lifecycle union, widened to `string` because the wire is a string. */
  status: string;
  /** Null unless `status === 'error'`. A stable key; the wording lives in `messages/*.json`. */
  errorCode: string | null;
  /**
   * WHY a `disabled` mailbox is disabled, when the ORGANIZER LEASE decided it (mail 0027).
   *
   * The raw wire token, colon and all — {@link standDownToken} is what turns it into copy. Null
   * is the ordinary disconnect, and under `status === 'disabled'` that distinction is the whole
   * of what separates "you removed this" from "somebody else has claimed it".
   */
  disabledReason: string | null;
  /** WHY a `connected` mailbox is not being synced (mail 0029). Null is the healthy case. */
  syncBlockedReason: string | null;
  /** When the CURRENT block began. `coalesce`d server-side, so it does not restart per pass. */
  syncBlockedSince: string | null;
  /** End of a completed worker cycle. Read ONLY as `=== null`. See the header. */
  lastSyncAt: string | null;
  /**
   * When this mailbox's FIRST import finished, or null while it has not (mail 0038).
   *
   * The ONE server stamp this module reads, and it is sound where `lastSyncAt` is not: it is
   * per-mailbox (not shared across the pass) and late (stamped only once a cycle drains with no
   * backlog), so its two failure modes do not apply. {@link deriveMailState} reads it as a FLOOR,
   * and ONLY as `=== null`: a null means the import is not known to be finished, which keeps
   * `importing` speaking whatever the mirror is doing — for {@link IMPORT_FLOOR_MAX_MS} after the
   * mailbox is connected, and past that only while this client cannot corroborate otherwise. It has
   * a THIRD failure mode the other two do not, and the bound is the answer to it: the write depends
   * on the worker reaching a cycle with no backlog, which is not guaranteed to happen at all, and a
   * mailbox that never gets there was measured holding a permanent "Syncing your mail" over a
   * finished mirror. See {@link importFloorSpeaks}. A missing field — an older server that has
   * not deployed the column — reads as `undefined`, which is not `=== null`, so a deploy skew
   * degrades to the prior growth-only behaviour rather than a false "still importing". See the
   * header.
   *
   * OPTIONAL, and that is the whole of the distinction: a server that omits the column must reach
   * the ladder as `undefined`, never as `null`. A seam that collapsed the absent field to `null`
   * (a `?? null` at the probe) would read every non-empty mirror as "still importing" for ever —
   * the floor arm fires on `=== null`, and a deploy skew has no null to offer it. `CloudShell`
   * therefore forwards the field untouched.
   */
  initialImportCompletedAt?: string | null;
  /**
   * HOW MANY OF THE USER'S OWN FILINGS THIS MAILBOX HAS NOT APPLIED YET.
   *
   * The API never opens IMAP: a Screener decision writes `folder_state` and the WORKER moves the
   * mail on its next cycle. So there is always a window in which ohmail shows the mail filed and
   * the user's server does not — and when the mail host is refusing connections, that window
   * does not close. Nothing else on this row notices: the mailbox is still `connected` (one
   * refused cycle does not earn `error`), `syncBlockedSince` is null because this is not one of
   * OUR infrastructure blocks, and the strip therefore said nothing at all while a backlog of
   * the user's own decisions built up on the server.
   *
   * OPTIONAL, and read with a `typeof === "number"` guard — the same rule, and for the same
   * measured reason, as {@link initialImportCompletedAt} above: a bundle or a server that
   * predates the column omits the field, and `undefined` must mean "this build cannot tell",
   * never `0`. Absent ⇒ the arm is skipped and the ladder behaves exactly as it did before the
   * column existed. The inverse mistake has its own cost: `Filing 0 messages on your mail
   * server…` is a sentence about nothing, which is why the arm tests `> 0` as well.
   */
  pendingMoves?: number;
  /**
   * THE BIGGEST MESSAGE THIS MAILBOX'S SUBMISSION SERVER SAID IT WILL ACCEPT, in bytes — the
   * server's own `SIZE` announcement, recorded when the mailbox was connected.
   *
   * `deriveMailState` must never read it, and does not: it says nothing about whether mail is
   * arriving. It is here for the same reason {@link MailboxFacts.id} is — `compose-from.ts` needs
   * it, and this is the narrowed shape `GET /mailboxes` arrives as.
   *
   * OPTIONAL and nullable, and the two mean different things by the rule
   * {@link MailboxFacts.initialImportCompletedAt} states: absent is an API that predates the
   * column, `null` is a server that announced no ceiling. Both resolve the same way at the compose
   * surface — fall back to the product constant — so nothing here has to tell them apart; the
   * distinction is kept because collapsing it is how the import floor was once broken.
   */
  smtpMaxSizeBytes?: number | null;
  /**
   * HOW MANY MESSAGES THE ACCOUNT HOLDS FOR THIS MAILBOX — the SERVER's count, not this
   * device's.
   *
   * The one fact on this row that is deliberately about somewhere else, and it exists because
   * the reader's question is a COMPARISON: how much of my mail is on this device? The numerator
   * is {@link MailStateInputs.mirrored} (the local mirror) and this is the denominator.
   *
   * TWO CONSUMERS, AND NEITHER OF THEM IS AN ALARM. The `importing` arm quotes the pair as
   * progress while the mirror MOVES, and the Mailboxes pane states it at rest as a quiet fact
   * about a windowed copy ({@link deviceHoldings}). It had a third — the `behind` strip state,
   * a standing warning triangle — which was removed on 2026-08-30; `deviceHoldings` carries why.
   *
   * ── IT IS NOT `messageCount`, AND THE NAME IS THE WHOLE POINT ───────────────────────────
   *
   * `MailboxDTO.messageCount` means "how much mail is in this mailbox" as answered by whichever
   * server was asked — so on a local engine it is the MIRROR's own count, and a comparison of a
   * number against itself is always "N of N". Two facts wearing one name is the mistake
   * `cloud-mirror.ts` already refuses when it declines to copy the hosted `lastSyncAt` onto a
   * mirrored row; this is the same rule pointed the other way. A field that says HOSTED in its
   * name cannot be filled from the local aggregate by accident.
   *
   * OPTIONAL, and read with a `typeof === "number"` guard on the rule
   * {@link MailboxFacts.pendingMoves} states: absent means "this build cannot tell", never `0`.
   * A `?? 0` at any seam would make an unknowable denominator look like an emptied account. The
   * hosted Cloud client never sends it — asking `GET /mailboxes` for counts on a 30 s heartbeat
   * is the full-table aggregate that route's own doc-block refuses — so on a browser tab every
   * consumer of it is simply unreachable, which is the intended shape rather than a gap.
   */
  hostedMessageCount?: number;
  /**
   * THE FORWARDING-DETECTION NOTICE's evidence pair (mail 0078). `inboundQuietSince` non-null is
   * a standing quiet episode: the worker judged this connected, healthily-syncing mailbox to
   * have received essentially no genuine inbound for a generous window while evidence says mail
   * should be arriving — the newest genuine inbound date the mailbox holds ("almost nothing
   * since {this}"). `inboundQuietDismissedAt` is the mailbox's dismissal.
   *
   * `deriveMailState` must never read them, and does not: the whole feature is a QUIET note on
   * the Mailboxes pane about a healthy mailbox, and a strip state would be the alarm the copy
   * exists to not be. The pane's show rule (health on screen, and `dismissedAt < since`) lives
   * with the pane that renders it.
   *
   * OPTIONAL, and absent means "this engine or API predates the columns" —
   * {@link MailboxFacts.initialImportCompletedAt}'s rule: forwarded untouched, no `?? null`,
   * because an absent pair must render nothing rather than a false "no episode" claim a later
   * consumer might learn to distinguish.
   */
  inboundQuietSince?: string | null;
  inboundQuietDismissedAt?: string | null;
  /** When this mailbox was connected. The one per-mailbox clock that is not shared. */
  createdAt: string;
}

/**
 * WHETHER THE FORWARDING-DETECTION NOTICE SHOWS on a mailbox row (mail 0078). Exported pure so
 * the suite can bite each clause, and IN THE SHARED SHELL because two panes render the same
 * notice — the Cloud client's `(product)/mailbox/MailboxSection` and the desktop's
 * `DesktopMailboxes` — and `(product)` is denied from the Desktop mirror. One rule, or the two
 * surfaces tell one mailbox's owner two different stories.
 *
 * Structural `Pick`-shaped parameter so both callers' row types fit (`MailboxDTO` declares the
 * pair optional, {@link MailboxFacts} too — an absent pair is an older server and renders
 * nothing, which is what NULL means anyway).
 *
 * Three claims, each one a sentence in the notice, each one a gate:
 *
 *  · `inboundQuietSince` set — the worker recognised a quiet episode; the server's pass
 *    (`apps/worker/src/inbound-quiet.ts`) is the predicate's single owner and this function
 *    re-derives none of it.
 *  · the mailbox is HEALTHY ON SCREEN — `connected`, no `syncBlockedSince`, a `lastSyncAt`.
 *    The copy opens with "syncing works"; on an errored, blocked or never-synced row that claim
 *    is false, the error/block copy owns the row, and a second explanation would contradict it.
 *    The episode itself survives an outage server-side (the pass never clears on unhealthy), so
 *    this gate HIDES rather than resets — health back, notice back, dismissal intact.
 *  · not dismissed, or dismissed BEFORE this episode's evidence: `dismissedAt < since` re-shows
 *    only when newer inbound exists than the press knew about — which requires mail to have
 *    actually flowed after the dismissal (the pass clears an episode only on real flow, and a
 *    new episode stamps the newer date). Sameness holds; a state change re-notifies.
 *
 * Timestamp comparison via `Date.parse`, not string order: both are ISO-8601 from one server,
 * but a lexicographic compare would silently invert on any future format drift.
 *
 * `now` is a PARAMETER, not `Date.now()` read inside, for the same reason the worker's pass
 * takes a clock: the health claim includes FRESHNESS — a `connected` row whose last completed
 * cycle is a day old is a mailbox whose syncing story belongs to the outage surfaces, not to
 * copy that opens with "syncing works" (review finding, round 1: non-nullness alone kept the
 * claim on screen through an arbitrarily long outage). The threshold mirrors the worker's own
 * trip gate, declared here because the worker's module is not importable from the shell.
 */
export const INBOUND_QUIET_SHOW_FRESH_MS = 24 * 60 * 60 * 1000;

export function showInboundQuiet(m: {
  status: string;
  lastSyncAt: string | null;
  syncBlockedSince?: string | null;
  inboundQuietSince?: string | null;
  inboundQuietDismissedAt?: string | null;
}, now: number): boolean {
  if (!m.inboundQuietSince) return false;
  if (m.status !== "connected" || m.lastSyncAt === null || m.syncBlockedSince) return false;
  if (now - Date.parse(m.lastSyncAt) > INBOUND_QUIET_SHOW_FRESH_MS) return false;
  if (!m.inboundQuietDismissedAt) return true;
  return Date.parse(m.inboundQuietDismissedAt) < Date.parse(m.inboundQuietSince);
}

/**
 * THE ACCOUNT'S OWN MESSAGE TOTAL, summed over the mailboxes that can be behind — or `null`.
 *
 * EVERY-OR-NOTHING, and that is the load-bearing half. A partial sum is not a smaller total, it
 * is a WRONG total: two mailboxes of which one reports 20,000 and the other reports nothing
 * would put "1,114 of 20,000" on screen while the true denominator is 34,000, and the same
 * arithmetic with the absent field read as `0` understates it in exactly the situation the
 * feature exists for. One missing answer therefore withdraws the whole claim, which is the
 * behaviour every other optional field on {@link MailboxFacts} already has.
 *
 * SUMMED OVER EVERY MAILBOX THE FACTS CARRY, connected or not, because the NUMERATOR is the whole
 * mirror — `MailStateInputs.mirrored` is every message in the local store, and a disconnected
 * mailbox's mail stays there (nothing is deleted for a disconnect). Summing only the connected
 * rows against that numerator compares two different populations: with mail retained for a
 * disabled mailbox the pair on screen is wrong in the reader's favour (it counts messages the
 * denominator does not) and a real shortfall on the connected mailbox is masked or hidden
 * entirely. An earlier version of this function did exactly that.
 *
 * A mailbox the hosted account no longer names has no entry in the map at all — a local tombstone
 * keeps its mail but reports no count — so that case withdraws the denominator through the rule
 * below rather than through a filter here, which is the same fail-safe by a shorter path.
 */
export function hostedTotal(mailboxes: readonly MailboxFacts[]): number | null {
  if (mailboxes.length === 0) return null;
  let sum = 0;
  for (const m of mailboxes) {
    if (typeof m.hostedMessageCount !== "number") return null;
    sum += m.hostedMessageCount;
  }
  return sum;
}

/**
 * **WHAT THIS DEVICE HOLDS, AGAINST WHAT THE ACCOUNT HOLDS** — the pair, or `null` when no
 * sentence may quote one.
 *
 * ── THIS IS NOT AN ALARM, AND IT USED TO BE ─────────────────────────────────────────────────
 *
 * There was a strip state for this pair — `behind`, a warning triangle at the foot of the rail
 * reading "This device holds N of the account's M messages", standing for as long as the two
 * numbers differed. It was removed after a field report that it reads as a constant warning
 * rather than as information, and the reason it went is not taste:
 *
 *  · A DIFFERENCE BETWEEN THE TWO NUMBERS IS THE NORMAL SHAPE OF THIS PRODUCT. The desktop's
 *    Cloud mirror is a window over the hosted account — `apps/sidecar/src/cloud-read.ts` says
 *    so at the `GET /messages` hole in its read table — and the mail outside the window is
 *    reachable on demand through the reach-past doors: the LIST door (`useOlderMail` →
 *    `HttpAdapter.listMessages`, which that read table deliberately does NOT answer locally, so
 *    it falls through to the hosted account) and the BODY door (`older-body.ts`, and
 *    `cloud-engine.ts`'s body fall-through for a row the mirror never held). Nothing is missing.
 *  · THE ARM COULD NOT TELL A HEALTHY WINDOW FROM A STALLED ONE. Its whole evidence was "the
 *    numbers differ and the mirror has not moved for 90 s", which is equally true of a mirror
 *    that has converged as far as this install will take it, one resting between the sidecar's
 *    20-second pulls, and one that has genuinely stopped. An alarm that fires for all three is
 *    an alarm about none of them. The signal that WOULD separate them — the sidecar's own "my
 *    last hosted drain reached the horizon and I am still short" — is not on any wire the shell
 *    can read; it is filed as a candidate rather than guessed at here.
 *  · AND THE BANNER CONTRADICTED ITS OWN DESTINATION. It linked to Settings → Mailboxes, where
 *    every row said "Up to date". One of the two was wrong, and it was the banner.
 *
 * The FACT is still worth stating, so it moved to where a question about it is asked: a quiet
 * line in the Mailboxes pane (`DesktopMailboxes.tsx`, `mailboxes.desktopHoldsCount`), beside the
 * sentence about whose copy this is. This function is that line's one derivation — and the same
 * arithmetic the `importing` arm quotes — so the pane cannot re-derive it into a different
 * answer.
 *
 * `null` in three cases, all of them "say nothing":
 *
 *  · `mailboxes === null` — the facts are not visible yet (the Desktop before its first read,
 *    the demo, a Cloud tab whose first poll has not landed). Not "there are none".
 *  · {@link hostedTotal} withheld the denominator — one silent mailbox withdraws the whole
 *    claim, because a partial sum is a WRONG total rather than a small one.
 *  · the total is not STRICTLY above `mirrored`. A denominator the numerator has reached or
 *    passed is a stale reading (a mailbox removed on the account keeps its mail locally, so the
 *    numerator can legitimately exceed a correct denominator), and the honest answer to a stale
 *    reading is to stop quoting it — never to clamp the two into an even fraction, which would
 *    read as though they had been measured together.
 */
export interface DeviceHoldings {
  /** Messages in the local mirror — every folder, every mailbox. */
  count: number;
  /** Messages the hosted account holds. Strictly greater than {@link DeviceHoldings.count}. */
  total: number;
}

export function deviceHoldings(
  mailboxes: readonly MailboxFacts[] | null,
  mirrored: number,
): DeviceHoldings | null {
  if (mailboxes === null) return null;
  const total = hostedTotal(mailboxes);
  if (total === null || total <= mirrored) return null;
  return { count: mirrored, total };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   IS THE MIRROR GROWING? — a pure reducer over two or more observations
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * How long a rise keeps counting, and how close two rises must be to belong to one run.
 *
 * Thirty seconds. It has to survive ONE missed 8 s poll plus its backoff jitter plus the
 * lumpiness of a worker writing an import in batches — a window of one or two poll periods
 * would flap between "syncing" and silence every time a large message took a moment, which is
 * worse than either sentence alone. It also has to be orders of magnitude below "this mailbox
 * finished importing three hours ago", which it is.
 *
 * A DURATION and not a count of polls, for the reason `syncBlockGraceMs` is one: a count
 * is a proxy for time that silently retunes the moment `POLL_MS` changes.
 *
 * ── IT BOUNDS THE RUN, NOT THE EPISODE ──────────────────────────────────────────────────
 *
 * The paragraph above predicted a flap if this window were one or two poll periods. It was the
 * right argument aimed at the wrong clock, and the flap happened anyway at thirty seconds: the
 * gap that governs mid-import is not the CLIENT's 8 s poll, it is the SERVER's cycle — a poll
 * interval of 60 s by default. No 30 s window can span one of those, so every server cycle tore
 * the run down and the strip had to start again.
 *
 * This constant still decides what counts as ONE RUN of rises, which is the evidence that an
 * import has BEGUN. What outlives it is the episode — see {@link IMPORT_END_IDLE_MS}.
 */
export const GROWTH_WINDOW_MS = 30_000;

/**
 * How long an import EPISODE survives a mirror that is not moving.
 *
 * ── THE DEFECT THIS NUMBER EXISTS FOR ───────────────────────────────────────────────────
 *
 * Observed in a real import: three worker drains with 45 s of idle between them showed
 * the strip FIVE times, with 31-second quiet gaps inside a single import. Every one of those
 * gaps is longer than {@link GROWTH_WINDOW_MS}, so each one ended the run — and with the run
 * gone the strip had to re-earn two rises AND the delta before it could speak again.
 *
 * ── WHY NINETY SECONDS ──────────────────────────────────────────────────────────────────
 *
 * The quiet gap mid-import is ONE SERVER CYCLE. The server kicks that cycle on a poll interval
 * that defaults to 60 s, and the client then needs up to one 8 s `POLL_MS` to see what the cycle
 * wrote — a floor of 68 s. The largest gap actually measured was 45 s. Ninety clears both with
 * room for a cycle that overruns, and `test/mail-state.test.ts` asserts the relation against the
 * server's own constant rather than against this sentence.
 *
 * ── AND WHAT IT COSTS, SAID OUT LOUD ────────────────────────────────────────────────────
 *
 * The strip now lingers up to 90 s after the last message instead of 30 s, over a count that has
 * stopped moving — and `SyncBar.tsx`'s spinner keeps turning for all of it. That is a real cost,
 * accepted, because there is NO end-of-import signal to replace it with: `lastSyncAt` cannot be
 * read positively (see the file header, both defects), and `/sync` answers `hasMore` about one
 * DRAIN, never about the import. A tail of stale-but-true beats a strip that appears five times,
 * which is the defect that was actually filed.
 */
export const IMPORT_END_IDLE_MS = 90_000;

/**
 * How much a run of rises must add before it is called an IMPORT rather than the post.
 *
 * Without this the strip appears for one decay window every time any mail arrives, on every
 * busy morning, for ever — which is precisely the "permanent chrome nobody reads" that
 * `SyncBar.tsx` was built to avoid. Twenty-five messages is crossed in ~19 s at the measured
 * import rate (27 messages / 20 s) and is not crossed by a thread burst.
 *
 * It is measured against {@link MirrorGrowth.added} — what the run ADDED — and no longer against
 * `count - runStartCount`, which was a NET delta a single delete could walk back. That was the
 * first defect; the field's own doc has the mechanism.
 *
 * The first import of a mailbox does not have to reach it, because a run that starts from an
 * EMPTY mirror is unambiguous. See {@link isImporting}.
 */
export const IMPORT_MIN_DELTA = 25;

/**
 * What the sampler remembers. Two observations are the minimum evidence for "growing", so a
 * single arrival can never make the claim.
 */
export interface MirrorGrowth {
  /** The last count observed. */
  count: number;
  /** When the count last ROSE. `-Infinity` until it ever has — never `Date.now()`. */
  lastRiseAt: number;
  /** Rises in the CURRENT run. `growing` needs two; one rise is an arrival, not an import. */
  rises: number;
  /** The count this run started from. Zero means "this mirror was empty", i.e. a first import. */
  runStartCount: number;
  /**
   * Messages the current run has ADDED. Cumulative, and never reduced — the first defect.
   *
   * The qualifier used to be `count - runStartCount`, a NET delta, and a fall moves `count` while
   * deliberately leaving `runStartCount` alone ({@link growthStep} says why). So every delete, and
   * every message a Screener backfill moved out of the mirror, SHRANK the evidence that an import
   * was under way: the net delta walked back and forth across {@link IMPORT_MIN_DELTA} and the
   * strip followed it, on and off, for as long as the backfill ran.
   *
   * `added === count - runStartCount` exactly when no fall has happened in the run — which is the
   * whole "and nothing else changed" claim, and is asserted rather than asserted-in-a-comment.
   */
  added: number;
  /**
   * THE EPISODE LATCH — the second and third defects, which are the same defect.
   *
   * True from the moment a run first qualifies as an import until the mirror has been still for
   * {@link IMPORT_END_IDLE_MS}. It is deliberately NOT cleared when a RUN ends, and that is the
   * point: both qualifiers that can start an episode are effectively single-use in a session.
   * `runStartCount === 0` can only hold before the first gap, because {@link growthStep} moves the
   * baseline off zero and never back; and `bootstrapping` goes false on this tab's first
   * successful drain (`sync-scheduler.ts`) and never returns. So without a latch, an import that
   * pauses for 31 seconds has to re-earn two rises AND twenty-five messages before the strip may
   * speak again — five times during one import, which is what was measured.
   *
   * A boolean and not a timestamp: nothing reads WHEN the episode began, and everything
   * time-based reads `lastRiseAt`, which is the fact that actually decays. A field nobody reads
   * is a claim under test that fails.
   */
  importing: boolean;
}

/**
 * The seed. `lastRiseAt: -Infinity` and not `Date.now()`, deliberately.
 *
 * The mirror persists into IndexedDB, so a tab that opens onto a settled mailbox starts at
 * 495 rather than at 0. Seeding the clock with "now" would make the next arrival look like the
 * second rise of a run that never had a first, so every reload of a healthy mailbox would
 * announce an import. `-Infinity` makes the first rise unambiguously a first rise.
 *
 * `importing: false` for the same reason, and it is the one place the latch does not survive: a
 * tab opening mid-import cannot tell itself apart from a tab opening onto a settled mailbox, so
 * it must claim nothing. It re-enters through `bootstrapping` while its own first drain runs, and
 * after that needs {@link IMPORT_MIN_DELTA} more messages to latch — the cold-start behaviour this
 * module always had, and the episode timeout above does not change it.
 */
export function seedGrowth(count: number): MirrorGrowth {
  return {
    count,
    lastRiseAt: -Infinity,
    rises: 0,
    runStartCount: count,
    added: 0,
    importing: false,
  };
}

/**
 * Fold one observation of the mirror's size in.
 *
 * A FALL — a delete, a move out of the mirror — moves the baseline and touches nothing else.
 * It is not a rise, and it is not evidence that the previous rise did not happen. That was
 * already true and already deliberate; what changed is that it now MATTERS, because `added`
 * is the qualifier and a fall may not reduce it.
 */
export function growthStep(prev: MirrorGrowth, count: number, now: number): MirrorGrowth {
  if (count === prev.count) return prev;
  if (count < prev.count) return { ...prev, count };
  const continues = now - prev.lastRiseAt <= GROWTH_WINDOW_MS;
  const rises = continues ? prev.rises + 1 : 1;
  // A new run starts from the count BEFORE this rise — so a run that begins on an empty
  // mirror has `runStartCount === 0`, which is what identifies a first import.
  const runStartCount = continues ? prev.runStartCount : prev.count;
  const added = (continues ? prev.added : 0) + (count - prev.count);
  // THE EPISODE OUTLIVES THE RUN. A 31 s gap ends the run — it is longer than GROWTH_WINDOW_MS —
  // and must not end the import, because the worker's cycle is 60 s and a gap of that size is
  // simply what the middle of an import looks like from a client that can only see its mirror.
  const held = prev.importing && now - prev.lastRiseAt < IMPORT_END_IDLE_MS;
  const qualifies = rises >= 2 && (runStartCount === 0 || added >= IMPORT_MIN_DELTA);
  return { count, lastRiseAt: now, rises, runStartCount, added, importing: held || qualifies };
}

/**
 * Two rises, the second of them recent. Nothing else counts as growth.
 *
 * It is the ENTRY evidence, and {@link isImporting} bypasses it entirely once an episode has
 * latched — which is the most surprising line in this file, so it is said in both places. A
 * latched episode is not required to keep proving that the mirror is growing right now; it is
 * required only not to have been still for {@link IMPORT_END_IDLE_MS}.
 */
export function isGrowing(g: MirrorGrowth, now: number): boolean {
  return g.rises >= 2 && now - g.lastRiseAt < GROWTH_WINDOW_MS;
}

/**
 * Is this growth an IMPORT worth interrupting the screen for? Two ways in, all client facts.
 *
 * ── 1. THE EPISODE IS LATCHED ───────────────────────────────────────────────────────────
 *
 * {@link growthStep} set {@link MirrorGrowth.importing} when a run first qualified — it started
 * from an EMPTY mirror (a first import, the original defect itself), or it added
 * {@link IMPORT_MIN_DELTA} or more (a mid-import stall that resumed at count 300 is still an
 * import). The only question left here is whether the mirror has gone still for
 * {@link IMPORT_END_IDLE_MS}, which is the whole of the fix: the qualifiers are evaluated once,
 * at the rise that earns them, and never re-litigated between two worker cycles.
 *
 * ── 2. THIS TAB'S FIRST DRAIN HAS NOT COMPLETED ─────────────────────────────────────────
 *
 * A new device repopulating its own mirror. It is the one arm that CANNOT latch, because
 * `growthStep` is not told about `bootstrapping` — and it is not told because that would mean
 * changing `MailStateProvider.tsx`'s call, which is out of this module's reach. It does not need to
 * latch: it is true for seconds, it covers exactly the cold-start window `seedGrowth` describes,
 * and a run that matters outlives it by qualifying on its own.
 *
 * Not one of them reads a timestamp the server wrote. That rule — client-observed progress
 * only, never a server clock — is deliberate, and it
 * is why the import FLOOR (`initial_import_completed_at`, the case a partial server state needs)
 * is a separate arm in {@link deriveMailState}, not a third way into this function. See the header.
 */
export function isImporting(g: MirrorGrowth, bootstrapping: boolean, now: number): boolean {
  if (g.importing) return now - g.lastRiseAt < IMPORT_END_IDLE_MS;
  return isGrowing(g, now) && bootstrapping;
}

/**
 * How long the import FLOOR is trusted with no corroboration at all.
 *
 * Twenty-four hours, and the number's job is to DOMINATE any genuine first import rather than to
 * estimate one. The measurements this file already records are the scale it has to beat: a first
 * attach at around six minutes, twice; a few thousand messages drained in minutes; attaches are
 * SERIAL, so a second mailbox legitimately waits behind the first with nothing stamped the whole
 * time. A day is an order of magnitude past all of it, which is what makes the window safe to
 * treat as absolute — inside it the floor is obeyed exactly as it was before this bound existed.
 *
 * Exported so a test can drive either side of it rather than sleeping past a literal it cannot see.
 */
export const IMPORT_FLOOR_MAX_MS = 86_400_000;

/**
 * Does the server's unwritten stamp still entitle the strip to say "importing" about THIS mailbox?
 *
 * ── THE DEFECT THIS EXISTS TO END ───────────────────────────────────────────────────────
 *
 * `initial_import_completed_at` is written by the worker on the first cycle that drains with no
 * backlog, and by nothing else. A mailbox that never reaches such a cycle is therefore never
 * stamped — and the floor, as first written, read that as "still importing" FOR EVER. The shape of
 * it: a mailbox connected days earlier, `connected`, its `last_sync_at` minutes old, its mirror
 * fully drained and motionless, and the strip still announcing an import in progress over mail the
 * reader could already open. Worse where an account has more than one mailbox — the floor's `some`
 * let a single unstamped mailbox speak for every healthy one beside it.
 *
 * The stamp is documented as readable ONLY as `=== null`, meaning "not KNOWN to be finished". This
 * function is where that reading stops being turned into a positive, counted, clocked claim about
 * work in flight on evidence that is merely absent. A null is an unknown, and an unknown that has
 * outlived every plausible import — against a client that has drained and a mirror that has not
 * moved — is not grounds for a sentence about what the app is doing right now.
 *
 * ── WHY RELEASING IT DOES NOT BRING BACK THE PARTIAL MAILBOX ────────────────────────────
 *
 * Two structural reasons, and neither is a judgement call:
 *
 *  1. Inside {@link IMPORT_FLOOR_MAX_MS} the floor is ABSOLUTE — no corroboration is consulted and
 *     the behaviour is bit-for-bit what it was. The case the floor was written for (a tab meeting a
 *     partial server state minutes to hours after a connect) lives entirely inside that window.
 *  2. PAST the window, a server import that is genuinely still running re-enters through the growth
 *     arm above this one, which outranks it: {@link growthStep} re-qualifies a run at two rises and
 *     {@link IMPORT_MIN_DELTA} added, and a real backfill crosses that in seconds.
 *
 * What is left is exactly the case this bound is for: a mailbox older than the window whose server
 * import is not producing anything. That IS a server-side fault — but a permanent false "Syncing"
 * is the worse way to render it, and it is not a claim this client can honestly make.
 *
 * ── THE CORROBORATION IS THE WHOLE SYNC STATUS, NOT A BOOLEAN ───────────────────────────
 *
 * `bootstrapping` goes false only after `engine.syncOnce()` RESOLVES, and that call commits the
 * snapshot and then pages until `hasMore` is false — so `!bootstrapping` is precisely "this tab has
 * completed a full drain at least once". `failures === 0` is required WITH it and is not
 * belt-and-braces: the `failing` state is only reached at `failureStreak` consecutive failures, so
 * a mailbox one or two failed drains deep reaches this arm with a mirror that is frozen for the
 * WRONG REASON. A still `lastRiseAt` is then the absence of observation rather than evidence of a
 * quiet server, and releasing the floor on it would be reading a broken instrument as a reading.
 * The scheduler sets `failures = 0` and `bootstrapping = false` in the same success, so together
 * they mean "this tab has drained, and the most recent attempt worked".
 *
 * Taken as the struct rather than a pre-computed boolean deliberately: a bare `drained` parameter
 * is invertible at the call site with both polarities green against a resting fixture.
 */
export function importFloorSpeaks(
  mailbox: MailboxFacts,
  growth: MirrorGrowth,
  sync: { bootstrapping: boolean; failures: number },
  now: number,
): boolean {
  // `!== null` and not `!= null`, which is the deploy-skew rule the header and {@link
  // MailboxFacts.initialImportCompletedAt} both turn on: a server older than the column omits the
  // field, it arrives as `undefined`, and `undefined !== null` is true — so an absent stamp leaves
  // this function immediately and the ladder degrades to growth-only rather than announcing a
  // false import over every settled mailbox on the account.
  if (mailbox.initialImportCompletedAt !== null) return false;

  // Inside the window the floor is absolute. `Number.isFinite` fails for an unparseable or absent
  // `createdAt`, and that case DELIBERATELY takes the corroborated path below rather than the
  // absolute one: the alternative is a mailbox whose clock cannot be read holding a permanent
  // banner, which is the defect this function exists to remove, and the corroboration is what
  // makes skipping the window safe. Pinned by a test so it stays a decision rather than an
  // accident of `now - NaN < bound` evaluating false.
  const connectedAt = new Date(mailbox.createdAt).getTime();
  if (Number.isFinite(connectedAt) && now - connectedAt < IMPORT_FLOOR_MAX_MS) return true;

  // Past the window the client must have something of its own to say. It has not drained, or its
  // last drain failed: it has observed nothing it can rely on, so the server's claim stands.
  if (sync.bootstrapping || sync.failures > 0) return true;

  // Drained, healthy — so a mirror that is still moving is the import itself, and a mirror that has
  // been still for {@link IMPORT_END_IDLE_MS} is a server handing over nothing. `seedGrowth` leaves
  // `lastRiseAt` at `-Infinity`, so a tab that opens onto a settled mirror and never sees a rise
  // reads as still, which is the case that produced the report.
  return now - growth.lastRiseAt < IMPORT_END_IDLE_MS;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE LADDER
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ── THE SIX STATES ──────────────────────────────────────────────────────────────────────
 *
 *  1. `awaiting`      a mailbox is connected, no cycle has completed and the mirror is EMPTY.
 *                     The honest replacement for "Waiting for first sync" — often the correct
 *                     thing to say (a first attach was measured at ~6 minutes), and it says
 *                     how long, so it can never be a frozen spinner.
 *  2. `importing`     **THE MIRROR IS GROWING.** Keyed on the client's own count rising across
 *                     syncs, never on a stamp. Counts, never a percentage. An EPISODE rather
 *                     than a run of rises, because the worker writes an import in cycles a
 *                     minute apart and a state that re-qualified between them flapped.
 *  3. `screenerOnly`  emitted as {@link MailState.screenerCandidate}, not as a key: mail has
 *                     landed, the mirror is settled and nothing is wrong. The OHBOX pane
 *                     combines it with its own emptiness — a fresh account is mostly Screener
 *                     by design, so this is where an empty Ohbox is CORRECT and needs saying.
 *  4. `blocked`       our own infrastructure is declining to serve the mailbox
 *                     (`syncBlockedReason`, mail 0029) — the UI half of the block the
 *                     server records on the row.
 *  5. `mailboxError`  the mailbox itself refused us (`status === 'error'`, `errorCode`).
 *  6. `noMailbox`     the probe answered, and there are none. Distinct from "we cannot see".
 *
 * ── AND THE ONE THAT WAS HERE AND IS NOT A STATE ────────────────────────────────
 *
 * `behind` — "this device holds N of the account's M" — was a seventh arm and a warning triangle
 * at the foot of the rail. It is GONE, and {@link deviceHoldings} carries the whole argument: a
 * windowed mirror in front of working reach-past doors is the product behaving correctly, the arm
 * could not tell that apart from a stalled copy, and an alarm over a healthy state teaches people
 * to ignore the alarms that matter. The pair it quoted is still said, quietly, in the Mailboxes
 * pane. Do not put it back on the strip without a signal that distinguishes the wrong shape.
 *
 * ── AND THE TWO THAT ARE NOT THIS LADDER'S ──────────────────────────────────────────────
 *
 * `stopped` and `failing` belong to the failure strip and they OUTRANK all six. The reason is the rule
 * `OhboxView`'s counter already followed and this one inherits: once the drains are failing the
 * mirror count is FROZEN, so every claim below about growth is a claim about a number that
 * cannot move. A frozen counter is the same lie in a new font.
 *
 * `failing` has ONE cause, and it is a SUSTAINED one: `failureStreak` consecutive failed drains.
 * It used to have a second — a single coded 401/403 the server had not yet re-made (`sync.refused`)
 * — and that second cause was the "Sync failed. Retrying." false alarm reported on open: a transient
 * 401 on the first `/api/sync` (a cold function, a warming session, a deploy alias mid-roll — all
 * recoverable, all documented in `sync-scheduler.ts`) painted a failure banner over a first sync
 * that was about to succeed, and cleared itself a minute later when the confirm drain landed. A
 * refusal one request old is not a sustained failure, so it no longer reaches `failing`; it falls
 * through to the calm progress states. Only when the server RE-MAKES the refusal does the loop latch
 * `terminal` and reach `stopped` — the confirmation already required in front of the stronger
 * banner, now honoured by the weaker one too.
 *
 * `quiet` is the resting value and it is most of the time. There is no permanent "everything
 * is fine" chrome to learn to ignore.
 */
export type MailStateKey =
  | "stopped"
  | "failing"
  | "stale"
  | "catchingUp"
  | "blocked"
  | "mailboxError"
  | "filing"
  | "noMailbox"
  | "importing"
  | "awaiting"
  | "quiet";

export interface MailState {
  key: MailStateKey;
  /**
   * Does this state's copy depend on ELAPSED TIME rather than on a mirror change?
   *
   * If it does, the surface must run its own clock or the sentence freezes: a healthy tab
   * publishes an identical `SyncStatus` every eight seconds and `engine.tsx` deliberately
   * bails out of re-rendering for it, so nothing else would ever re-paint. See
   * `MailStateProvider.tsx`.
   */
  clock: boolean;
  /** Messages in the MIRROR. `importing` renders it; the others carry it for context. */
  count: number;
  /**
   * Messages in the ACCOUNT — the denominator {@link count} is measured against, or `null`
   * whenever no sentence may name one.
   *
   * `null` is the common case and must stay cheap to reach: the hosted browser client never
   * learns this number (see {@link MailboxFacts.hostedMessageCount}), one mailbox failing to
   * report withdraws it for the whole account, and — the arithmetic guard — it is withheld
   * whenever it is not STRICTLY greater than {@link count}. That last clause is what makes a
   * fraction whose top exceeds its bottom unreachable rather than merely unlikely: a denominator the numerator has
   * already passed is a stale reading, and the honest response to a stale reading is to stop
   * quoting it, not to clamp it to the numerator and render the two as equal, as though they had
   * been measured together.
   *
   * Carried by `importing` alone — progress, WHILE THE MIRROR MOVES — and that is now the only
   * place on the strip where a denominator may appear at all. A still mirror that is short of the
   * account is the ordinary shape of a windowed copy and gets no strip sentence ({@link
   * deviceHoldings}); every other state leaves this `null`, including the failure arms, because
   * once the loop is frozen the numerator cannot move and a fraction whose top is stuck is the
   * frozen-counter lie this module already refuses elsewhere.
   */
  total: number | null;
  /**
   * `blocked` only, and it is a COPY TOKEN rather than a wire value — `SyncBar` interpolates it
   * into `t(\`blocked_${reason}\`)`.
   *
   * A member of {@link SYNC_BLOCK_REASONS} (mail 0029, our infrastructure declining to serve a
   * `connected` mailbox) or of {@link STAND_DOWN_REASONS} (mail 0027, the organizer lease
   * declining to serve a `disabled` one), or `null` when the server sent a sync-block reason
   * this build does not know — the state still fires, with generic copy. Silence would re-create
   * mail 0029's "unobservable by design" one layer up.
   *
   * The two sets share one field and one state because they are one sentence to a reader: this
   * mailbox is not syncing, and here is why. They are kept apart at the SOURCE — different
   * columns, different closed sets, different writers — and joined only here, where the only
   * remaining question is which sentence to render. A stand-down never yields `null`: see
   * {@link standDownToken}.
   */
  reason: SyncBlockReason | StandDownReason | null;
  /** `mailboxError` only — the `errorCode` key whose sentence lives in `mailboxes.err_*`. */
  errorCode: string | null;
  /**
   * `stale` only — the instant the mirror on screen was last known current, verbatim from the
   * freshness input (the engine's own completion stamp, or the desktop mirror's). It is the
   * time the label renders — "As of 14:32 · catching up" — and the arm never fires without it:
   * a staleness claim with no time in it is not a sentence anyone can check.
   */
  asOf: string | null;
  /** The mailbox the state is ABOUT, when it is about exactly one. */
  address: string | null;
  /**
   * Whole minutes this state has been true, and WHICH clock differs per state because the
   * useful number does:
   *
   *  · `blocked`  — since `syncBlockedSince`, the server's own record of the block.
   *  · `awaiting` — since the mailbox was CONNECTED (`createdAt`). The one per-mailbox clock
   *                 that is not shared between rows, and the honest answer to "how long have
   *                 I been looking at this".
   *
   * `null` when the stamp behind it is absent or unparseable.
   */
  minutes: number | null;
  /**
   * `awaiting` only — has this outlasted what a first import is measured to take?
   *
   * Not a different state: the same fact, said without the explanation, plus the one action
   * that exists. It never claims an error, because at this point nothing has failed.
   */
  slow: boolean;
  /**
   * Mail has landed, the mirror is settled, and nothing is wrong — so IF a list is empty, the
   * mail is in the Screener and that is worth saying.
   *
   * A flag and not a key, because it is a statement about the OHBOX. Rendered by the shell
   * strip it would tell somebody standing in the Screener that everything is in the Screener.
   * The rule `SyncBar.tsx` enforces is one DERIVATION, not one DOM node: this is derived here,
   * once, and the pane may only combine it with the row count it is already the authority on.
   * The pane may not re-derive it.
   */
  screenerCandidate: boolean;
  /**
   * `filing` only — how many of OUR OWN filings the mail server has not applied yet.
   *
   * A field of its own and not `count`, which is documented as the size of the MIRROR and is
   * carried by every state for context. Overloading it would make one number mean two things
   * depending on the key beside it, and the first surface to read it without checking the key
   * would report a backlog of six as a mailbox holding six messages.
   *
   * `0` in every other state. The arm never fires at 0 — see {@link MailboxFacts.pendingMoves}
   * for why "Filing 0 messages" is as wrong as silence is.
   */
  pending: number;
  /**
   * **MAY AN EMPTY LIST BE STATED AS A SETTLED FACT?**
   *
   * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────
   *
   * Reported from real use: opening ohmail.app signed in, over a slow connection, shows "no
   * messages". Reproduced against the shipped shell with `/sync` held
   * open — the first paint and the paint five seconds later are the same three sentences:
   *
   *     Ohbox · 0 unread of 0 messages · All clear · ✉ Nothing in your Ohbox.
   *
   * Every one of them is a claim about the user's own mail, made in the product's voice, before
   * the product has finished looking. "Empty", "not loaded yet" and "the read failed" are three
   * different facts and the panes had one rendering for all three.
   *
   * ── WHAT IT IS, AND WHY IT IS NOT A KEY ─────────────────────────────────────────────────
   *
   * `screenerCandidate`'s shape exactly, for `screenerCandidate`'s reason: it is a
   * QUALIFICATION of a fact each PANE owns ("my list is empty"), not an account-wide sentence.
   * The strip already has `awaiting` and `importing` for account-level progress; a seventh key
   * here would put a sentence on screen for the ~200 ms a fast connection takes, and
   * `engine.tsx` has already ruled that a sentence that flashes is worse than a quiet frame.
   * The panes, by contrast, are ALREADY rendering something in that slot — replacing a false
   * sentence with a true one adds no chrome.
   *
   * ── THE DERIVATION READS THE LADDER'S VERDICT, NOT THE LADDER'S CONDITIONS ──────────────
   *
   * `!bootstrapping || key === "stopped" || key === "failing"`, and the second half is
   * deliberately expressed as KEYS rather than as `terminal || failures >= streak`.
   * Those are the same thing today ({@link deriveMailState}'s first two arms), and writing the
   * conditions out again would be a second copy of a precedence rule that lives twenty lines
   * away — the exact drift this module's header was written to end. A future change to what
   * counts as failing flows through for free — and one such change already happened: a single
   * unconfirmed `refused` no longer keys `failing`, so it no longer settles an empty list either,
   * which is correct (a transient refusal is not an answer about whether the mailbox is empty).
   *
   * ── WHY `bootstrapping` IS THE RIGHT CLOCK HERE, HAVING BEEN THE WRONG ONE THERE ────────
   *
   * `OhboxView`'s header records that a live COUNT gated on `bootstrapping` was the original defect:
   * it means "this TAB's first drain has not completed", which is seconds, while the WORKER's
   * first import is minutes — so the counter switched itself off and the pane went silent for
   * the whole import. That argument is about DURATION and it is untouched: progress still keys
   * on the mirror growing, and still lives in the strip.
   *
   * This is a different question with a different answer. "Has anything authoritative populated
   * this mirror yet" is exactly what `bootstrapping` means, and seconds is exactly the right
   * length for it — the scheduler hydrates from the device BEFORE it drains, so `!bootstrapping`
   * implies the local copy has already been read too.
   *
   * ── AND IT CANNOT SPIN FOR EVER ─────────────────────────────────────────────────────────
   *
   * A loop that is failing never clears `bootstrapping`, so without the two key arms a mailbox
   * whose network is down would say "still loading" until the tab was closed — one lie traded
   * for another. `stopped` and `failing` are precisely the states in which the strip is already
   * explaining that the mirror is frozen, so from there an empty list is as settled as it is
   * ever going to get and the panes may say so plainly.
   */
  settled: boolean;
}

const QUIET: MailState = {
  key: "quiet",
  clock: false,
  count: 0,
  total: null,
  reason: null,
  errorCode: null,
  asOf: null,
  address: null,
  minutes: null,
  slow: false,
  screenerCandidate: false,
  pending: 0,
  // Overwritten for every state by `deriveMailState`'s wrapper — see {@link MailState.settled}.
  // `true` here so that a `QUIET` used directly as a resting value never withholds a pane's
  // ordinary empty state.
  settled: true,
};

/**
 * When a first import has taken longer than one is measured to take.
 *
 * TEN minutes, and the number is set against a measurement rather than a feeling:
 * `mailbox_attach_started → mailbox_attached` has been timed at around six minutes, twice, on
 * a mailbox of a few thousand messages. So SIX minutes with an empty mirror is NORMAL, and
 * escalating at three would dress a healthy large-mailbox import as a fault — the opposite defect to the
 * one this change fixes, and just as false. Attaches are serial, so a second mailbox waits
 * behind the first; ten leaves room for that.
 *
 * **It must stay under the server's `syncLag` alert threshold (15 minutes), and
 * `test/mail-state.test.ts` asserts that against the real constant.** This is the
 * `syncBlockGraceMs < syncLagMs` argument one layer up: if the operators are paged before the
 * screen has escalated, the user is again the last to know — which is exactly the half-hour of
 * silence this whole module exists to end.
 */
export const AWAITING_SLOW_MS = 600_000;

/** Whole minutes since an ISO instant, floored, never negative. */
function minutesSince(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 60_000));
}

/** The oldest of the given ISO stamps — the one that has been true longest. */
function earliest(stamps: Array<string | null>): string | null {
  let best: { iso: string; t: number } | null = null;
  for (const iso of stamps) {
    if (iso === null) continue;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) continue;
    if (best === null || t < best.t) best = { iso, t };
  }
  return best?.iso ?? null;
}

/** Everything the ladder is allowed to read. Every field is something the CLIENT observes. */
export interface MailStateInputs {
  /**
   * `useSyncStatus()` — what the tab's own drain loop is doing.
   *
   * Structural, and re-declared rather than imported as `SyncStatus`, for the reason
   * {@link MailboxFacts} is: this module ships in the Desktop mirror. It carries all four fields
   * the scheduler publishes so the shape mirrors `SyncStatus` exactly, but the ladder keys states
   * on only three of them. `refused` — a coded 401/403 the server has not yet RE-MADE — is
   * received and NOT rendered as a failure: it is one request's evidence, weaker than `terminal`
   * and deliberately treated as transient, so a single one falls through to the calm progress
   * states rather than surfacing "Sync failed". Only a CONFIRMED refusal (`terminal`) speaks. See
   * {@link climb}'s `failing` arm.
   */
  sync: { bootstrapping: boolean; failures: number; terminal: boolean; refused: boolean };
  /** `SYNC_FAILURE_STREAK`, passed in so the surfaces cannot drift from the scheduler. */
  failureStreak: number;
  /**
   * THE FRESHNESS CONTRACT'S VERDICT (INSTANT-ARCH §6.6) — structural, re-declared rather than
   * imported as `MirrorFreshness` for the reason {@link MailboxFacts} is: this module ships in
   * the Desktop bundle. On the web it is `useFreshness()` — the engine's own derivation from
   * its completion stamp; on the desktop it is the SIDECAR mirror's verdict over
   * `GET /mirror/freshness`, because the window engine drains the sidecar's local feed and is
   * always "current" relative to it — its own stamp cannot say the desktop is behind the
   * hosted account.
   *
   *  · `unknown` — never drained; the panes' skeleton owns it, the strip says nothing.
   *  · `stale`   — the content on screen is truth as of `asOf`; the strip labels it quietly
   *    until a drain settles. NEVER silent: staleness labeled is honest, staleness silent is
   *    the bug (a mirror days old rendering as if current).
   *  · `current` — the resting state; nothing renders.
   */
  freshness: { state: "unknown" | "stale" | "current"; asOf: string | null };
  /**
   * THE RENDERED ENGINE'S OWN VERDICT — `useFreshness()`, never the probe. Identical to
   * {@link MailStateInputs.freshness} wherever no probe overrides (web, the demo); different on
   * the desktop, where the label reads the SIDECAR's stamp and this reads the window engine's.
   * It exists for exactly one reader: the `settled` wrapper. Settled is a statement about the
   * mirror ON SCREEN — the window engine's own in-memory store, which can be mid-first-snapshot
   * and empty while the sidecar's mirror is complete — so upstream freshness must not settle a
   * pane the rendered store has not populated. Review round 2's finding.
   */
  engineFreshness: { state: "unknown" | "stale" | "current"; asOf: string | null };
  /**
   * `GET /mailboxes`, narrowed — or `null` for "we cannot see mailboxes".
   *
   * **`null` and `[]` ARE DIFFERENT FACTS and the distinction is load-bearing.** `null` is the
   * demo, the Desktop bundle, a probe that has not answered yet, and a probe that FAILED; `[]`
   * is "the server told us there are none". Collapsing a rejected `GET /mailboxes` into `[]`
   * would render "No mailbox connected" to somebody who has five — a 503 turned into a lie
   * about their account.
   */
  mailboxes: MailboxFacts[] | null;
  /** Messages in the MIRROR — every folder, not the Ohbox's rows. */
  mirrored: number;
  /** The growth sampler's memory. THE progress signal. */
  growth: MirrorGrowth;
  /** `Date.now()`, injected so the ladder is pure and the tests need no clock control. */
  now: number;
  /** True in the demo and on the Desktop: a fixture world has no sync to report. */
  demo: boolean;
}

/**
 * WHAT TO SAY, from what the client can see — plus whether the panes may call an empty list
 * empty. Pure.
 *
 * ── THE STAMP IS APPLIED HERE AND NOT INSIDE THE LADDER ─────────────────────────────────
 *
 * {@link MailState.settled} is a property of EVERY state, and `climb` below has ten `return`
 * statements. Stamping it in one place rather than ten is not tidiness: it is what makes the
 * flag impossible to omit, including from the eleventh state somebody adds next year. The same
 * argument `stripSpeaks` makes about keys — the surfaces decide nothing — applied to a field.
 *
 * It is also why the derivation can read `climb`'s KEY: the verdict exists before the stamp
 * does. See {@link MailState.settled} for why that indirection is the point.
 */
export function deriveMailState(input: MailStateInputs): MailState {
  const state = climb(input);
  return {
    ...state,
    // A COMPLETED DRAIN IS SETTLED EVIDENCE, whatever this tab's own loop is doing — the mobile
    // boot rule (`mirrorSettled`), promoted (INSTANT-ARCH §6.6). `bootstrapping` means "this
    // TAB's first drain has not finished", which on a warm STALE resume is true for the whole
    // catch-up — and without this clause every zero-row pane wore a skeleton over a mirror the
    // freshness stamp proves renderable (a completed drain once emptied it; the strip is
    // meanwhile labeling the age). `unknown` — no stamp, or a probe that has not answered — is
    // exactly the population the skeleton exists for and keeps it.
    settled:
      !input.sync.bootstrapping || state.key === "stopped" || state.key === "failing"
      // The RENDERED engine's stamp, deliberately not the label's (probe-overridden) verdict:
      // on the desktop the sidecar can be current while the window's own mirror is still
      // mid-first-snapshot and empty — upstream freshness settles nothing here.
      || input.engineFreshness.state !== "unknown",
  };
}

/**
 * The ladder itself. First match wins.
 *
 * The order below is PRECEDENCE and is deliberately not the order the states are numbered in.
 * Each step says why it outranks the next.
 */
function climb(input: MailStateInputs): MailState {
  const { sync, failureStreak, freshness, mailboxes, mirrored, growth, now, demo } = input;

  // A fixtures engine drains once from local data and is permanently settled. There is no
  // sync here to have a state, and the demo promises that nothing leaves the tab — so it gets
  // the resting value before anything else is even considered.
  if (demo) return QUIET;

  // ── The loop's own health outranks everything, because it invalidates the evidence ──────
  //
  // `terminal` first: the loop has disarmed itself and will not restart, so no count below
  // can move and no mailbox fact below can be refreshed.
  if (sync.terminal) return { ...QUIET, key: "stopped" };
  // And a SUSTAINED failing loop means the mirror is FROZEN. `OhboxView`'s counter already stops
  // here; every state below would be reading a number that cannot change. The streak is what makes
  // this a SUSTAINED claim rather than a blip: `failureStreak` consecutive failures, which at the
  // backoff ceilings is well inside one cap — the network is down, and the strip may say so.
  //
  // `sync.refused` DELIBERATELY does NOT join it, and this is the fix for the false alarm that had
  // "Sync failed. Retrying." painted over a healthy first sync on every open. A single coded
  // 401/403 the server has not yet RE-MADE is one request's evidence, and `sync-scheduler.ts`
  // itself records that such a 401 on `/api/sync` is routinely TRANSIENT — a cold serverless
  // function, a session still warming, a deploy alias mid-roll. Rendering "failed" on it is the
  // same over-reach the `stopped` banner was moved behind a confirmation to end, one banner
  // weaker: it announces a failure on evidence that resolves in `REFUSAL_CONFIRM_MS`, and it did so
  // over a first sync that was about to succeed. So an UNCONFIRMED refusal is handled by the calm
  // `catchingUp` FLOOR below — never "failed" — rather than here. It is not answered with a scarier
  // sentence than the facts support, and (the other half, which the ladder used to get wrong) it is
  // not answered with silence either. What surfaces a failure banner is a SUSTAINED failure and
  // nothing else: the streak here, or a CONFIRMED refusal, which `sync-scheduler.ts` latches to
  // `terminal` and the `stopped` arm above renders. This mirrors the discipline of that non-latching
  // fix at the weaker banner.
  if (sync.failures >= failureStreak) return { ...QUIET, key: "failing" };

  // ── STALE — the content on screen is real and OLD, and the strip says which (stage 2) ───
  //
  // The Freshness Contract's labeled middle state: the mirror renders instantly (frame one is
  // local, always), a drain is converging behind it, and until that drain SETTLES the honest
  // sentence is "As of <time> · catching up" — the time being the last completed drain's own
  // stamp. It clears itself: a settled drain re-stamps, the freshness input flips to
  // `current`, and this arm stops matching. Nothing here is a claim about progress — the
  // importing arm below still owns the moving count — this is a claim about AGE.
  //
  // BELOW `stopped` and `failing`, deliberately: those mean the loop is frozen or dead, so
  // "catching up" would be a false statement about what the app is doing — the failure arms
  // already explain why the mirror cannot move. ABOVE everything else, including the
  // `mailboxes === null` probe gate: staleness is an ENGINE fact, known before any probe
  // answers — and the first seconds of a days-stale resume, when the probe has not landed,
  // are exactly when the label is owed. It also outranks `blocked`/`importing` for the label's
  // one job: while the view is not current, nothing may present it as current — the stronger
  // per-mailbox sentences return the moment the mirror is.
  //
  // NEVER without a time: `asOf` is the sentence's checkable half, and the freshness input
  // carries it for every `stale` by construction (the engine reports `unknown`, not `stale`,
  // when the stamp is missing or unreadable). The guard is belt for a probe-fed desktop value.
  if (freshness.state === "stale" && freshness.asOf !== null) {
    return { ...QUIET, key: "stale", clock: true, count: mirrored, asOf: freshness.asOf };
  }

  // ── The calm FLOOR for an UNCONFIRMED coded refusal ─────────────────────────────────────
  //
  // `sync.refused` is a 401/403 our API made about this identity ONCE and has not yet RE-MADE
  // (`REFUSAL_CONFIRM_MS`, sync-scheduler.ts). It must never be answered with the scary "Sync
  // failed. Retrying." — the confirm window exists so a refusal that resolves inside it is not
  // announced as a failure (the arm above) — and it must never be answered with SILENCE. A coded
  // refusal answered with nothing on screen is the invariant this floor exists to hold: the strip
  // says something true and calm the whole time the refusal is being confirmed.
  //
  // But it is a FLOOR, not a high-priority arm, and the difference is deliberate. The visible states
  // below — `awaiting` ("the first sync has not finished"), `importing` ("Syncing your mail"),
  // `blocked`, and the rest — are calm true sentences in their own right, so a refusal DURING one of
  // them changes nothing a reader needs: a first-sync refusal shows the first-sync sentence, not a
  // generic "catching up" (`test/mail-state.test.ts` pins exactly that). What this replaces is only the
  // SILENT `quiet` fall-throughs — a `null` mailbox probe, no connected mailbox, and above all the
  // settled mirror whose screener pointer is silent by design — which is the exact settled case the
  // ladder used to answer a refusal with nothing at all. Once the refusal is CONFIRMED the scheduler
  // latches `terminal` and the `stopped` arm above renders the banner and the sign-in remedy.
  //
  // Not in the `settled` keys (see {@link MailState.settled}) on purpose: a transient refusal is not
  // an answer about whether the mailbox is empty.
  const quietOrCatchingUp: MailState = sync.refused ? { ...QUIET, key: "catchingUp" } : QUIET;

  // "We cannot see mailboxes" — not "there are none". Everything from here reads them. Silent unless
  // a refusal is being confirmed, in which case the floor speaks rather than the screen going blank.
  if (mailboxes === null) return quietOrCatchingUp;

  const live = mailboxes.filter((m) => m.status !== "disabled");

  /* ── 4a. STOOD DOWN — the ORGANIZER LEASE is declining to serve it ──────────────────────
   *
   * ── THE FALSE SENTENCE THIS ARM EXISTS TO DELETE ─────────────────────────────────────
   *
   * Observed on a real Cloud account. A mailbox connect was
   * accepted end to end and then lost the organizer claim to a LOCAL install whose heartbeat was
   * three hours stale, so the worker wrote `status='disabled'` +
   * `disabled_reason='organized_elsewhere:local'`. The `live` filter one line above drops every
   * `disabled` row — which is correct for the six states below it and catastrophic here — and
   * with the account's only mailbox dropped, `live.length === 0` fired and the strip said
   * **"No mailbox connected, so nothing can arrive"** to somebody who had connected one three
   * minutes earlier. Three statements on one screen, no two of them agreeing.
   *
   * ── IT SCANS `mailboxes`, NOT `live`, AND THAT IS THE ENTIRE FIX ─────────────────────
   *
   * A stood-down mailbox IS disabled — the status is honest, `markMailboxStoodDown` wrote it on
   * purpose, and the six states below have no business speaking about a row nothing is syncing.
   * What was missing is that "disabled" has two causes and the product only ever knew one of
   * them. `disabledReason` is the discriminator, and it is why this arm cannot simply relax the
   * filter: an ordinary disconnect must still reach `noMailbox`, because a user who removed
   * their only mailbox HAS no mailbox and telling them so is correct.
   *
   * ── AND IT OUTRANKS `blocked`, NOT THE OTHER WAY ROUND ───────────────────────────────
   *
   * Both say "this mailbox is not syncing". A sync block is our own infrastructure declining and
   * RETRYING — `reconcileSyncBlocks` rewrites it every roster pass and it clears itself when the
   * fault does. A stand-down is terminal from the product's side: `loadEnabledMailboxes` filters
   * `status <> 'disabled'`, so the row is off the roster entirely and no amount of waiting moves
   * it. Between two true sentences, the one that is not going to stop being true wins.
   *
   * Above the growth states for the reason `blocked` already is, verbatim: a mailbox nobody is
   * syncing is not syncing, whatever a second mailbox is doing to the mirror.
   *
   * `minutes` stays null. There is no `disabled_since` column — nothing timestamps a stand-down
   * — and inventing an elapsed time from `createdAt` would be measuring the wrong thing. `Since`
   * renders nothing for a null, which is the path `blockedUnknown` already takes.
   */
  /* `typeof === "string"` AND NOT `!== null`, and the difference is a caught defect. The field
   * is typed `string | null`, but a probe compiled before the field existed — a cached Cloud
   * bundle, a fixture that predates it — simply omits it, and `undefined !== null` is TRUE. That reading
   * turns EVERY ordinary disconnect into an organizer conflict, which is a brand-new false
   * sentence in the place a false sentence was being removed. It went red on exactly that. */
  const stoodDown = mailboxes.find(
    (m) => m.status === "disabled" && typeof m.disabledReason === "string",
  );
  if (stoodDown) {
    return {
      ...QUIET,
      key: "blocked",
      count: mirrored,
      reason: standDownToken(stoodDown.disabledReason),
      address: stoodDown.address,
    };
  }

  // ── 4. BLOCKED — our own infrastructure is declining to serve it (mail 0029) ────────────
  //
  // Above the error and progress states both. The mailbox is `connected` and has no
  // `errorCode` — that is the entire design of the column — so nothing else on this ladder
  // would notice it; and if a mailbox is not being synced at all, "syncing" is false even
  // when a second mailbox happens to be growing the mirror.
  //
  // THE TEST IS `syncBlockedSince !== null`, AND IT IS NOT THE FIELD IT LOOKS LIKE IT SHOULD BE.
  //
  // This line used to read `m.syncBlockedReason !== null` with a comment saying the test is
  // `!== null` and NOT `isSyncBlockReason` — the right rule, aimed one field to the left. The
  // server NARROWS the reason to the closed set and forwards the timestamp UNCONDITIONALLY, so a
  // server that grows a fourth reason emits `{syncBlockedReason: null, syncBlockedSince: <ts>}` —
  // the narrowing has already happened by the time it reaches us, and refusing to narrow again
  // here bought nothing because there was nothing left to narrow. Gating on the reason gave that
  // mailbox silence, which is exactly what this column was added to end.
  //
  // A timestamp is also the safer predicate to have chosen: it cannot carry a server-authored
  // token, so the generic copy below is authored here and nowhere else.
  //
  // COMPLETE only because `reason non-null ⇒ since non-null` — an audit of the server found five
  // writers, each setting and clearing both columns in one statement, and no CHECK enforcing it.
  const blocked = live.find((m) => m.syncBlockedSince !== null);
  if (blocked) {
    return {
      ...QUIET,
      key: "blocked",
      clock: true,
      count: mirrored,
      reason: isSyncBlockReason(blocked.syncBlockedReason) ? blocked.syncBlockedReason : null,
      address: blocked.address,
      minutes: minutesSince(blocked.syncBlockedSince, now),
    };
  }

  // ── 5. MAILBOX ERROR — the mailbox itself refused us ───────────────────────────────────
  //
  // Above the progress states because a mailbox in `error` is quarantined and earning a
  // backoff: whatever the mirror is doing, THIS mailbox is contributing nothing to it.
  const failed = live.find((m) => m.status === "error");
  if (failed) {
    return {
      ...QUIET,
      key: "mailboxError",
      count: mirrored,
      errorCode: failed.errorCode ?? "unknown",
      address: failed.address,
    };
  }

  // ── 5a. FILING — WE HAVE FILED THE MAIL AND THE SERVER HAS NOT ─────────────────────────
  //
  // ── THE STATE THAT HAD NO SENTENCE ───────────────────────────────────────────────────
  //
  // Invariant #3: the serverless API never opens IMAP. Every decision writes `folder_state`
  // and returns; the WORKER performs the move on its next cycle. So there is always a window
  // where ohmail shows the mail filed and the user's own mail server still holds it where it
  // was — and if the host is refusing connections, the window does not close.
  //
  // Nothing above this arm can see that. The mailbox is `connected` (a single refused cycle
  // does not earn `error` — that takes `maxSyncFailures` in a row, or a refused ATTACH), it is
  // not `blocked` because a sync block is OUR infrastructure declining and this is theirs, and
  // it is not `stoodDown`. So the ladder fell straight through to `quiet` and the product
  // looked finished while the backlog grew. The user's evidence was the mail moving in ohmail;
  // their mail server disagreed silently and for as long as the outage lasted.
  //
  // ── WHY HERE, AND NOT HIGHER OR LOWER ────────────────────────────────────────────────
  //
  // BELOW `mailboxError`: a mailbox in `error` is quarantined and earning a backoff, and
  // "your mail server refused us" is the larger, more actionable fact — a pending backlog on a
  // mailbox that is already reported broken adds nothing a person can act on differently.
  //
  // ABOVE `importing` and everything under it: those states are about mail COMING IN, and this
  // is about the user's own decisions GOING OUT. A first import can run for minutes and is
  // expected to; unapplied filings are not, and burying them under "Syncing your mail" for the
  // duration of an import is how this stayed invisible in the first place.
  //
  // ── THE `typeof` GUARD IS THE PRECEDENT ONE ARM UP, RESTATED ─────────────────────────
  //
  // `typeof m.pendingMoves === "number"` and NOT `m.pendingMoves != null` — the stale-probe
  // reading `stoodDown` records the same rule and the same caught defect: a bundle or a server
  // compiled before the field simply OMITS it, and `undefined != null` is false but
  // `undefined > 0` is also false, so only the positive test says what is meant. An absent
  // field is "this build cannot tell" and it must produce silence, not a number.
  //
  // `> 0` is the other half: `Filing 0 messages on your mail server…` is a sentence about
  // nothing, and it would be on screen for every healthy account permanently.
  //
  // SUMMED across live mailboxes, and the ADDRESS is the one they belong to only when there is
  // exactly one — the strip makes account-wide statements (see `awaiting`'s `every`), and
  // naming one of two mailboxes beside a total covering both would be a sentence whose two
  // halves are about different things.
  const filing = live.filter((m) => typeof m.pendingMoves === "number" && m.pendingMoves > 0);
  const outstanding = filing.reduce((n, m) => n + (m.pendingMoves ?? 0), 0);
  if (outstanding > 0) {
    return {
      ...QUIET,
      key: "filing",
      // The mirror is not the subject here, but every state carries it for context.
      count: mirrored,
      pending: outstanding,
      address: filing.length === 1 ? filing[0]!.address : null,
      // TIME-DEPENDENT, so the strip runs its own clock: nothing in the MIRROR changes when the
      // worker drains this backlog — `folder_state` is server-side and `/sync` carries no
      // change for a move that has already been applied locally — so a state keyed only on
      // mirror movement would never re-paint and the number would freeze at whatever it was.
      clock: true,
    };
  }

  // ── 6. NO MAILBOX — the probe answered, and there are none ─────────────────────────────
  //
  // Reachable only because `mailboxes` is known to be non-null. Nothing can arrive, and no
  // amount of waiting changes that, so the two progress states below would both be false.
  if (live.length === 0) return { ...QUIET, key: "noMailbox" };

  const connected = live.filter((m) => m.status === "connected");
  if (connected.length === 0) return quietOrCatchingUp;

  // ── 2. IMPORTING — the mirror is growing ───────────────────────────────────────────────
  //
  // Above `awaiting` by construction (`awaiting` requires an empty mirror) and above the
  // Screener pointer, because while mail is still landing "it is all in the Screener" is a
  // claim about a set that is still changing.
  //
  // `now` is the SHELL's clock, beaten every `MAIL_CLOCK_MS` by `MailStateProvider` while
  // `state.clock` is true — which is what ends a latched episode. The reducer only ever runs when
  // the mirror MOVES, so an import that simply stops would otherwise never be told it had.
  // THE DENOMINATOR — {@link deviceHoldings}, which is also what the Mailboxes pane's quiet
  // holdings line reads. ONE derivation, deliberately: the pane and the strip must not be able to
  // answer "how much of the account is on this device" differently, and the every-or-nothing sum
  // plus the strict `> mirrored` clamp are the whole of that answer. `null` here means no
  // sentence on this strip may name a total, which is the common case (a hosted browser tab never
  // learns the hosted counts at all).
  const totalIfAhead = deviceHoldings(mailboxes, mirrored)?.total ?? null;

  if (isImporting(growth, sync.bootstrapping, now)) {
    return { ...QUIET, key: "importing", clock: true, count: mirrored, total: totalIfAhead };
  }

  /**
   * HAS ANY CYCLE COMPLETED? The ONE use of `lastSyncAt`, and only as a negative.
   *
   * Sound under BOTH worker defects (see the file header): only ids in `synced` are ever
   * stamped, so a null cannot be somebody else's success and cannot be an early stamp. It
   * means "not one cycle has completed for this mailbox".
   *
   * It is also NECESSARY, not merely safe. A non-null stamp over an empty mirror means a cycle
   * ran and the mailbox is genuinely empty — which must be QUIET (the ordinary empty pane),
   * not "waiting for the first sync" for ever.
   *
   * ── `every` AND NOT `some`, AND THE LIMIT THAT BUYS ─────────────────────────────────────
   *
   * With two mailboxes where one has synced and one never has, `every` is false and the strip
   * stays quiet about the young one. Deliberate, and the division is: the STRIP makes
   * account-wide statements; a per-mailbox statement belongs on the per-mailbox ROW
   * (`(product)/mailbox/MailboxSection.tsx`, in the same change, from this same state). `some`
   * would put "nothing has arrived" over a mirror already full of mail from the other
   * mailbox — a new false claim rather than a missing true one.
   */
  const noCycleYet = connected.every((m) => m.lastSyncAt === null);

  // ── 1. AWAITING — connected, and nothing at all has arrived ────────────────────────────
  //
  // The state the dead string was shown for, and it is often CORRECT. What was wrong was
  // saying it alone, for ever, and saying it while the mirror grew. It carries the elapsed
  // minutes so it cannot be mistaken for a frozen spinner, and escalates past
  // `AWAITING_SLOW_MS` — to a plainer sentence, never to a claim that something failed.
  if (noCycleYet && mirrored === 0) {
    const since = earliest(connected.map((m) => m.createdAt));
    return {
      ...QUIET,
      key: "awaiting",
      clock: true,
      address: connected.length === 1 ? connected[0]!.address : null,
      minutes: minutesSince(since, now),
      slow: since !== null && now - new Date(since).getTime() >= AWAITING_SLOW_MS,
    };
  }

  // ── 2b. THE IMPORT FLOOR — the SERVER has not stamped this mailbox's first import done ──
  //
  // ── THE CASE ARM 2 CANNOT SEE ────────────────────────────────────────────────────────
  //
  // A first import drains newest-first in bounded batches over minutes, so the server holds a
  // PARTIAL mailbox — a recent block, a gap, then older mail — for the whole of it. Arm 2 keys on
  // THIS CLIENT's mirror growing, which is the right progress signal but a blind one at the edges:
  // a tab that opens onto the partial state after the growth run has lapsed, or that catches up to
  // it, sees a settled mirror and falls through to the Screener pointer below — declaring a
  // mailbox with a hole in it complete. The Screener then shows a recent block, jumps to old mail,
  // and presents that as the whole of it.
  //
  // `initial_import_completed_at` is the server's own answer, and it is the ONE stamp this module
  // reads. It is stamped once, per mailbox, only when a worker cycle drains with no backlog — so
  // unlike `lastSyncAt` it is neither shared nor early, and a NULL genuinely means "the first
  // import is not finished". Read as a FLOOR: while any connected mailbox has not been stamped, the
  // strip says "importing" regardless of what the mirror is doing.
  //
  // `=== null` AND NOT `== null`: an older server that has not deployed the column omits the field,
  // which arrives as `undefined`. `undefined === null` is false, so a deploy skew degrades to the
  // prior growth-only behaviour rather than announcing a false import over every settled mailbox —
  // the same `typeof`-shaped care the stand-down arm above takes for `disabledReason`.
  //
  // `some` AND NOT `every`, which is the opposite of `noCycleYet` one arm up, because the sentence
  // is: "importing" over a partially-full mirror is TRUE while even one mailbox's FLOOR STILL
  // SPEAKS, whereas "nothing has arrived" over a mirror the other mailbox already filled would be
  // false. The release is judged PER MAILBOX inside that `some` and never account-wide: a mailbox
  // connected five minutes ago must keep an absolute floor even while a four-day-old sibling on the
  // same account releases, and an account-wide test would strip the protection from the young one.
  //
  // ── THE FLOOR IS BOUNDED, AND WHY IT HAD TO BE ─────────────────────────────────────────
  //
  // As first written this arm trusted an unwritten stamp for ever. Nothing guarantees the worker
  // ever reaches a no-backlog cycle, and a mailbox was observed going four days without one while
  // syncing healthily — so the strip announced an import permanently, over a mirror that was
  // complete, current and readable, and the `some` here spread that across a second mailbox that
  // was properly stamped. {@link importFloorSpeaks} owns the
  // bound and its full argument; the short version is that inside a day the floor is untouched,
  // and past it the client must be able to corroborate with a completed drain, a healthy loop and
  // a motionless mirror before it stops repeating a claim the server never made.
  //
  // `mirrored > 0` is the gate, and it is what confines this to the case it exists for. The defect
  // is a PARTIAL mailbox — mail on screen with a hole in it — reading as complete, so there has to
  // be mail on screen for the floor to matter. With an empty mirror there is nothing being
  // presented as complete: the `awaiting` arm above already owns "connected, nothing arrived", and
  // its deliberate `every` (a mixed pair stays QUIET, the young mailbox's status belongs on its
  // ROW) must not be overridden here by a `some` that would announce an account-wide import over a
  // mirror with zero rows in it. Below `awaiting` and gated on the same `mirrored > 0` the Screener
  // pointer uses, so when the mirror has content the answer is exactly one of: still importing
  // (here) or done and pointing at the Screener (below).
  // `clock: true` is load-bearing on THIS arm in a way it is not on the others: the floor's release
  // is driven by elapsed time and by nothing else, so it repaints only because `MailStateProvider`
  // beats the clock while `state.clock` is true. Drop it and the bound above still passes every
  // unit test and never fires on an idle tab.
  if (mirrored > 0 && connected.some((m) => importFloorSpeaks(m, growth, sync, now))) {
    return { ...QUIET, key: "importing", clock: true, count: mirrored, total: totalIfAhead };
  }

  // ── 3. THE SCREENER POINTER — a candidate, for the OHBOX to finish ─────────────────────
  //
  // Mail has landed, the mirror is settled and nothing above matched. `mirrored > 0` is
  // load-bearing rather than defensive: without it an account that has never received
  // anything would offer to explain where its mail went.
  //
  // THE SETTLED-CASE FLOOR. This is where the silence hole was: a mirror that had already drained
  // left an unconfirmed refusal with no calm progress arm to fall into, so it fell here to `quiet`
  // — silence. When a refusal is being confirmed the floor speaks instead, and `screenerCandidate`
  // stays false (a refusal is not the "all clear, it's in the Screener" moment).
  if (sync.refused) return { ...QUIET, key: "catchingUp", count: mirrored };
  return { ...QUIET, count: mirrored, screenerCandidate: mirrored > 0 };
}

/**
 * The states the SHELL STRIP renders, in every view.
 *
 * `screenerCandidate` is not among them and never can be — it is not a key. The strip renders
 * account-wide truths; the one view-level truth is finished by the view that owns the fact.
 * Neither surface may re-derive anything.
 */
export function stripSpeaks(key: MailStateKey): boolean {
  return key !== "quiet";
}
