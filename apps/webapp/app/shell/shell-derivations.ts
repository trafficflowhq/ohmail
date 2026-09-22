"use client";

/**
 * THE SHELL'S WHOLE-MIRROR DERIVATIONS — the consent partition, the projection every pile is read
 * through, and the lists, counts and lookups built over them.
 *
 * One module because they are one pass: the partition decides where a message is PRESENTED,
 * `presented` IS that mirror, and every memo below is keyed `[presented, derived]` so a new
 * projection is a new derivation and a body landing is not. Lifted out of `AppShell.tsx`
 * unchanged (ARCH-022). It holds no setter, no verb and no `toast`, and imports nothing from
 * `routing-undo.ts`: the held presses arrive as a map.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  consentPartition,
  draftsList,
  feedPartition,
  ohboxView,
  parkedMessageIds,
  presentAt,
  presentationReader,
  receiptsByDay,
  resurfacedThreads,
  rulesList,
  scheduledSendsList,
  sendingMailboxId,
  tagsCrossView,
  threadParticipantsIndex,
  threadSizeIndex,
  threadSubject,
  triagePiles,
  type ConsentPartition,
  type EngineDraft,
  type EngineMessage,
  type EntityReader,
  type Folder,
  type FolderEntity,
  type OhmailEngine,
  type TagDTO,
} from "@ohmail/client-engine";
import { readBootCache, writeBootCache } from "./boot-cache";
/* Backspace/Delete → Trash, and the window in which it has not happened yet. See the module. */
import { hideMessages } from "./delete-undo";
import { folderTailVerdict, folderUnreadCounts } from "./folders";
import { avatarHue, initialsOf } from "./format";
import { mailboxLabelKey, mailboxLabelResolver } from "./mailbox-label";
import type { MailboxFacts } from "./mail-state";
import { useOlderMail } from "./older-mail";
import { ohboxSurfaceMessages } from "./ohbox-surface";
import { readOwner } from "./owner-cookie";
import type { ViewId } from "./routing";
import { useStableCallback } from "./stable-callback";
import { useTrashPage } from "./trash-page";
import { useTrashWindow, type TrashWire } from "./trash-window";
import type { MailboxEntity, NotificationsMeta } from "../views/SettingsView";

export interface ReadsAiChipEntity {
  afterId: string;
  label: string;
  approvedLabel: string;
  correctedLabel: string;
}

/** The `boot-cache.ts` scope for the account's own addresses. See `ownAddresses` below. */
const OWN_ADDRESSES_BOOT_SCOPE = "own-addresses";

/**
 * The memo key for {@link ShellInner}'s `ownAddresses` — see there for why
 * the addresses and not the facts row. Sorted and lower-cased so the same
 * set in a different order, or with different server casing, is one key.
 * JSON, never a join character: a literal NUL join once made `file` report
 * this source as `data` and every grep-family tool skip it in silence.
 * JSON escapes its own delimiters, so no two distinct lists can produce
 * one string, and every byte of the result is printable.
 */
function ownAddressKey(
  facts: ReadonlyArray<{ address: string }> | null,
  remembered: readonly string[] | null,
): string {
  const list = facts?.map((m) => m.address) ?? remembered ?? [];
  return JSON.stringify([...list].map((a) => a.trim().toLowerCase()).sort());
}

/** A cached address list an older build wrote degrades to "no cache", never to mixed types. */
function acceptAddressList(parsed: unknown): string[] | null {
  if (!Array.isArray(parsed)) return null;
  return parsed.every((x): x is string => typeof x === "string") ? parsed : null;
}

/**
 * "No conversation of people here", as ONE array for the whole app.
 *
 * Most rows in most lists are not threads, so this is the answer nearly every lookup gives. A
 * fresh `[]` each time would be a new prop identity on every render of every row — see
 * `participantsOf`.
 */
const NO_PARTICIPANTS: { initials: string; hue: number }[] = [];

/**
 * WHAT THE DERIVATIONS ARE HANDED. Every field is required and none has a default: a forgotten
 * `demo` would partition the fixture world, which is the shape of an absent configuration
 * selecting the live branch. `consent`, `route` and the three windows arrive under the shell's
 * own names and narrowed to the fields read here — the type is the boundary, so the module
 * cannot reach a route field or a window verb it has no business with, and every body below is
 * the one `AppShell.tsx` had.
 */
export interface ShellDerivationsInput {
  engine: OhmailEngine;
  /** The mirror as it is — `engine.read()` from the render, never re-read here. */
  reader: EntityReader;
  /** The derived stamp every whole-mirror memo is keyed on (`useDerivedVersion`). */
  derived: number;
  demo: boolean;
  /** The browser's own answer (`useResolvedDemoMode`): what a gate that READS or ISSUES asks. */
  resolvedDemo: boolean;
  now: Date;
  /** `GET /mailboxes`, or null while it has not answered. */
  facts: MailboxFacts[] | null;
  /** Is the seed screen still owed? The live Trash window is not opened under it. */
  seedOwed: boolean;
  consent: {
    known: boolean;
    standalone: boolean;
    dormancyDays: number;
    screeningBaselineAt: string | null;
    screeningScope: "window" | "all_time";
    foldersEnabled: boolean;
    folderMailboxesOff: Record<string, string>;
  };
  route: { view: ViewId; folderId: string | null };
  /** The host's own Trash transport, `undefined` where there is none. */
  trashWire: TrashWire | undefined;
  /** The delete window's held ids — what the projection subtracts. */
  deleting: { held: ReadonlySet<string> };
  /** The restore window's held ids — what the Trash page subtracts. */
  restoring: { held: ReadonlySet<string> };
  /** Where a held routing press is showing its mail. Read, never written. */
  routing: { places: ReadonlyMap<string, Folder> };
}

/** The record the shell composes with. Consumers destructure it: a memo may not depend on it. */
export type ShellDerivations = ReturnType<typeof useShellDerivations>;

export function useShellDerivations({
  engine, reader, derived, demo, resolvedDemo, now, facts, seedOwed, consent, route, trashWire,
  deleting, restoring, routing,
}: ShellDerivationsInput) {
  /**
   * The account's own addresses, from `GET /mailboxes` — passed explicitly,
   * not left to the default. `consentPartition` falls back to the mirror's
   * `mailbox` entities, and a live `/sync` feed carries none: an empty set
   * on exactly the surface that matters, so the user is not recognised as
   * themselves and their own mail (a note to self, a cross-account
   * forward) queues in their own Screener. The demo's mirror DOES hold
   * mailbox rows, so no fixture test could have shown this.
   */
  /**
   * …AND THE BOOT USES THE DEVICE'S COPY OF THAT ANSWER. `facts` is a round trip away on every
   * load, and a partition computed with an empty own-set for that interval would present the
   * user's own recent self-mail in their own Screener — the same boot-window defect the consent
   * cache below closes, on this input. So the addresses ride the same per-account boot cache:
   * written whenever `GET /mailboxes` has answered, read while `facts` is still null, keyed by
   * the remembered account id, and never applied over a live answer (`facts` wins the `??`).
   * An address list neither authorises nor loads anything — it only stops the account being
   * treated as a stranger to itself for the first round trip.
   */
  const [rememberedOwn, setRememberedOwn] = useState<string[] | null>(null);
  useEffect(() => {
    /* `resolvedDemo`, not `demo`: on a prerendered demo page the raw flag is false for one
       render, and this one carries a PREVIOUS account's remembered addresses into the fixtures
       world rather than issuing a request. */
    if (resolvedDemo) return;
    const owner = readOwner();
    if (owner === null) return;
    if (facts) {
      writeBootCache(OWN_ADDRESSES_BOOT_SCOPE, owner, facts.map((m) => m.address));
      return;
    }
    const cached = readBootCache(OWN_ADDRESSES_BOOT_SCOPE, owner, acceptAddressList);
    if (cached !== null) setRememberedOwn(cached);
  }, [resolvedDemo, facts]);
  /**
   * Keyed on the addresses, not the facts row. `consentView` depends on nothing else about a
   * mailbox, and keyed on `facts` it rebuilt the whole-mirror partition whenever ANY field
   * moved — `pendingMoves` decrements on every poll for hours on a fresh mailbox. A STRING of
   * the sorted, lower-cased addresses rather than the identity of `facts`: the provider's
   * equality gate stops the poll that learned nothing, this stops the poll that learned
   * something the partition does not care about. Sorted and lower-cased is the KEY only — the
   * value keeps the server's order and case; nothing downstream may see a folded address.
   */
  const ownAddresses = useMemo(
    () => facts?.map((m) => m.address) ?? rememberedOwn ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ownAddressKey(facts, rememberedOwn)],
  );
  /**
   * THE ACCOUNT'S OWN NAME FOR ONE OF ITS ADDRESSES — what the "me" recipient chip wears
   * (viewer redesign). `GET /mailboxes` carries `displayName` per mailbox (nullable; OAuth connects
   * fill it from the provider's id_token, IMAP connects only when the user typed a label), and
   * that is the ONLY name the shell can honestly claim as the account's: the signup name
   * (`users.displayName`) never reaches `app/shell/**`, which may not call the API directly.
   * Null — no label, no facts (the demo, the desktop) — and the chip shows the bare address
   * rather than an invented name.
   */
  const ownNameOf = useStableCallback((address: string): string | null => {
    const key = address.trim().toLowerCase();
    const label = facts
      ?.find((m) => m.address.trim().toLowerCase() === key)
      ?.displayName?.trim();
    return label ? label : null;
  });
  /**
   * WHICH OF THE ACCOUNT'S MAILBOXES A MESSAGE WAS DELIVERED TO, for the surfaces that name it —
   * `ownNameOf`'s sibling, off the same `GET /mailboxes` facts, and the ONLY derivation of it. The
   * "more than one mailbox" gate lives inside `mailboxLabelResolver`, so no consumer re-derives it
   * (the divergence `folderMailboxes`' count prop exists to prevent). Memoised on the labels and
   * not on `facts`, for `ownAddresses`' reason: `pendingMoves` moves on every poll for hours on a
   * fresh mailbox, and a label does not depend on it. Stable across that rebuild, so the reading
   * pane's chrome is not a new object each time a mailbox row twitches.
   */
  const mailboxLabels = useMemo(
    () => mailboxLabelResolver(facts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mailboxLabelKey(facts)],
  );
  const mailboxLabelOf = useStableCallback((mailboxId: string): string | null =>
    mailboxLabels(mailboxId));
  /**
   * …AND THE ENGINE IS TOLD THE SAME CUTLINE THE PARTITION BELOW IS DRAWN WITH.
   *
   * A windowed mirror decides dormancy from the mail it kept, the server from the whole account,
   * and the dial offers 90, 180 and 365 days against a 90-day window — so two of its three rungs
   * put the cutline past the window. Past it a sender whose only mail the window evicted is
   * dormant here and active there: filed in History, never asked about. So the engine widens its
   * retention to cover the cutline (`maxRows` still decides the size), read from the SAME
   * `consent` fields the partition is keyed on, so the two cannot be measured differently.
   */
  useEffect(() => {
    if (demo || !(consent.known || consent.standalone)) return;
    engine.setCutline({ dormancyDays: consent.dormancyDays, scope: consent.screeningScope });
  }, [engine, demo, consent.known, consent.standalone, consent.dormancyDays, consent.screeningScope]);
  const consentView: ConsentPartition | null = useMemo(
    // The demo is not partitioned — consent derives from rules and the
    // fixture world has none, so the partition would empty the curated world into History. Nothing
    // is partitioned before the account's window is known: `consent.known` is false until `GET
    // /consent` lands or the boot applies the account's CACHED last answer (`boot-cache.ts` —
    // without it every reload resurrected already-decided senders). A tab that cannot know shows
    // MORE, never less. The desktop (`consent.standalone`) partitions anyway: there is no stored
    // window to guess at, so the default IS the truth — read as "not yet known" it killed the
    // cutline for the whole desktop tier. The baseline rides the
    // same `GET /consent` answer as the window: one fetch, both halves.
    () =>
      demo || !(consent.known || consent.standalone)
        ? null
        : consentPartition(reader, {
            now,
            dormancyDays: consent.dormancyDays,
            baselineAt: consent.screeningBaselineAt,
            // THE MODE, or the window it names is resolved and then ignored (mail 0083). The
            // server's router has honoured `all_time` since the column landed; this partition is
            // what the Screener queue and the History placement are actually built from on the
            // client, so without this line the Settings control writes a value the open tab —
            // and, on a standalone install, the whole product — never reads.
            screeningScope: consent.screeningScope,
            ownAddresses,
            // The History-lens gate (spec §16.5): the CONSENT answer, not the mirror's folder
            // entities — stale entities after a missed disable must not keep the lens on.
            foldersEnabled: consent.foldersEnabled,
          }),
    [
      demo, consent.known, consent.standalone, reader, derived, now, consent.dormancyDays,
      consent.screeningBaselineAt, consent.screeningScope, ownAddresses, consent.foldersEnabled,
    ],
  );
  /**
   * The same mirror, with every message sitting where it is PRESENTED.
   *
   * Fed to the pile selectors and to nothing else. They group by folder, and after this
   * projection grouping by folder IS grouping by place — which is what lets History exist
   * without a single server-side move. History's own contents are absent from it entirely and
   * are read from `consentView.history`.
   */
  const presented = useMemo(
    /* …MINUS ANYTHING INSIDE ITS UNDO WINDOW. `hideMessages` returns the base reader unwrapped
       while nothing is held, which is every render but the few seconds after a Delete, so the
       normal path pays nothing and keeps its memo identities. It is composed HERE and not into
       `reader` for `presentationReader`'s own reason: the mirror's reader is what every mutation,
       body open and search reads, and a delete that has not happened yet must still be there. */
    /* …AND SHOWS A HELD ROUTING PRESS WHERE IT WAS FILED. A row's place comes from its sender's
       rule, so a press whose rule is waiting out its undo window would move nothing on screen;
       `presentAt` carries the named rows for the length of it and returns the reader unwrapped
       the rest of the time, exactly as `hideMessages` does. */
    () => presentAt(
      hideMessages(consentView ? presentationReader(reader, consentView) : reader, deleting.held),
      routing.places,
    ),
    [reader, consentView, deleting.held, routing.places],
  );

  /**
   * Mail from beyond what this device kept — one keyset page at a time, on
   * an explicit ask. The browser's mirror is a window over a server that
   * still holds everything, so the bottom of a pile is a boundary, not an
   * end; see `older-mail.ts` for why nothing fires speculatively and the
   * rows are never written to the mirror. Inert on a client whose mirror
   * IS the mailbox: `listOlderAvailable()` is false for the demo and the
   * standalone desktop, and the view renders no control.
   */
  /** The open folder's entity id, for the reach-past hook below — route-derived, shell-early. */
  /**
   * The Trash page — off-mirror, fetched on arrival, dropped on leaving.
   * `route.view`, not `effectiveView`: this is a fetch, and `effectiveView`
   * is derived from things that can withhold the stage (the seed screen) —
   * rendering the seed screen over Trash should not throw away an arrived
   * page, and coming back should not need a second fetch. The held-restore
   * ids are subtracted here rather than in the view — one place, so the
   * list and the rail count cannot disagree.
   */
  const trashPage = useTrashPage(engine, route.view === "trash", restoring.held);
  /**
   * THE LIVE TRASH WINDOW — the mail server's own \Trash, read beside the mirrored deletes and
   * never written anywhere. Gated exactly as the Junk window is: the hook is called
   * unconditionally and what is CONDITIONAL is `active`, so nothing is read in the demo, with
   * "Use folders" off, before the first seed, or away from the view. The PROP below adds
   * `supported` — a build whose api client is a refusing stub would otherwise hold a permanent
   * loading state over the section.
   */
  const trashWindow = useTrashWindow(
    !demo && consent.foldersEnabled && !seedOwed && route.view === "trash",
    trashWire,
  );
  const folderIdForOlder = route.view === "folder" ? (route.folderId ?? undefined) : undefined;
  /**
   * Deliberately no client-derived boundary for the folder reach-past. The obvious one — the
   * folder's oldest mirrored row — is wrong on a windowed mirror whose held rows are not
   * contiguous (pinned rows, the labeled tail): an outlier below the window would become the
   * boundary and every unmirrored row between would be skipped, permanently. So page one starts
   * at the folder's newest and the view's id-filter drops what the mirror already renders —
   * overlap-and-deduplicate, cost extra presses, failure mode none. The wire's `startBelow`
   * stays for a future contiguous-edge derivation; nothing arms it today.
   */
  const folderOlderBoundary = undefined;
  /** The open folder entity, read ONCE per render for the reach-past pieces below: the verdicts
   *  judge against it, and its absence marks the unjudgeable gap the epoch tracker watches. */
  const folderEntityForOlder =
    folderIdForOlder ? reader.get<FolderEntity>("folder", folderIdForOlder) : undefined;
  /**
   * THE FOLDER TAIL'S SCOPE EPOCH — bumps when the open folder's entity RE-ENTERS the mirror
   * after an absence (the flag toggled off and on over an open folder URL). While the entity
   * is absent every verdict is "hold" and no latch moves; moves that end in a window prune
   * during that gap erase their own evidence, so when the entity returns the hook drops its
   * pages and latches and the tail re-earns its rows from the server — the one authority the
   * gap did not silence. A ref mutated in render, transition-edged so StrictMode's double
   * invoke cannot double-bump; a folder change resets the tracker (the hook resets on the id
   * change anyway).
   */
  const folderTailEpoch = useRef({ folderId: undefined as string | undefined, present: false, epoch: 0 });
  {
    const t = folderTailEpoch.current;
    const present = folderEntityForOlder !== undefined;
    if (t.folderId !== folderIdForOlder) folderTailEpoch.current = { folderId: folderIdForOlder, present, epoch: 0 };
    else if (present && !t.present) { t.epoch += 1; t.present = true; }
    else if (!present && t.present) t.present = false;
  }
  const older = useOlderMail(engine, "ohbox", derived);
  /**
   * The open FOLDER's reach past the mirror window (the folders foundation) — `older`'s twin,
   * keyed to the folder entity id so leaving a folder resets its paging. Called with an
   * undefined id whenever no folder is open, which the transport reads as "no list"
   * (unavailable) — hooks must be unconditional, the scope may be absent.
   */
  const folderOlder = useOlderMail(
    engine, "folder", derived, folderIdForOlder, folderOlderBoundary,
    /* The per-render verdicts — `folderTailVerdict` is the pure, branch-tested word (see the
       hook's `suppress` for what each verdict does to the latch): in this folder ⇒ hidden and
       un-latched (an observed return); shown elsewhere by the LIVE entity ⇒ banned; entity
       absent ⇒ held, latches untouched; not held at all ⇒ the fetched copy shows. The
       unjudgeable entity-absent gap is settled by `folderTailEpoch` above, not by memory. */
    (id) => folderTailVerdict(reader.get<EngineMessage>("message", id), folderIdForOlder, folderEntityForOlder),
    folderTailEpoch.current.epoch,
  );

  /* Engine-derived world. Every memo below is a whole-mirror pass keyed
   * `[presented, derived]`: `presented` because a new consent projection is
   * a different mirror, `derived` because the projection cannot carry a
   * cache of its own.  `derived` and not the global version: a body landing
   * moves the mirror and moves nothing any of these read (`useDerivedVersion`). These rebuild when what they derive from changes —
   * the mirror, the overlay on it (`useEngineVersion` merges it), or where
   * consent presents the rows — never read them as "only when a message
   * changed". Every rebuild is retained as long as the render scope that
   * made it, so every callback here reads through a ref
   * (`stable-callback.ts` is the account of that mechanism). */
  const ohbox = useMemo(() => ohboxView(presented), [presented, derived]);
  /* One row per resurfaced conversation, and the badge for what arrived since the pin went up —
     the same derivation the phone reads. `ohbox.resurfaced` stays per message and is what
     `held()` inside the selector holds out; this is the shape the list renders. */
  const resurfacedRows = useMemo(() => resurfacedThreads(presented), [presented, derived]);
  const partition = useMemo(() => feedPartition(presented, "reads"), [presented, derived]);
  /**
   * Receipts is a FLAT list, exactly as Reads is — no day headings.
   *
   * `receiptsByDay` stays the source because it is the ordering: newest day first, and newest
   * within a day. Flattening it here preserves that order exactly and leaves the view with no
   * grouping concept at all. The selector's `label` is no longer rendered anywhere; it is the
   * boundary the sort is defined by, not a heading.
   */
  const receipts = useMemo(
    () => receiptsByDay(presented, now).flatMap((g) => g.items),
    [presented, derived, now],
  );
  /**
   * Receipts' OWN waterline partition — `view_meta` "receipts_waterline", independent of
   * Reads' by construction (`waterlineIdOf`). `feedPartition` walks `messagesIn` in the same
   * date order the day-flatten above preserves, so `fresh.length` is a junction into
   * `receipts` and not a parallel ordering that could drift.
   */
  const receiptsPartition = useMemo(
    () => feedPartition(presented, "receipts"),
    [presented, derived],
  );
  const piles = useMemo(() => triagePiles(presented), [presented, derived]);
  /**
   * WHICH MAIL IS PARKED IN A BOTTOM PILE — the same derivation `piles` above is built from
   * (`selectors.ts#parkedMessageIds`), so the set and the lists cannot disagree about it.
   *
   * Read by `openTargetFor`, which must not route a parked message to the Ohbox: no Ohbox group
   * lists one, so the arrival would select nothing and flash nothing. See that function.
   */
  const parked = useMemo(() => parkedMessageIds(presented), [presented, derived]);
  const tagGroups = useMemo(() => tagsCrossView(presented), [presented, derived]);
  /**
   * IS THIS CLIENT'S MIRROR A WINDOW? The configured policy, not a measurement of what the mirror
   * currently holds: a list derived from the WHOLE mirror — History — is bounded whenever a policy
   * is in force, and only the policy is still true after a reload and at a mailbox smaller than
   * the window. Read once per engine; the policy is fixed for the life of one.
   */
  const windowedMirror = useMemo(() => engine.storeWindow() !== null, [engine]);
  /**
   * History: dormant, undecided, and read by construction. Newest first.
   *
   * Every row is stamped with `physicalFolder`, which the projection does not do for History
   * (it removes those messages rather than re-placing them). That stamp is the single rule the
   * reading pane goes by: **if a message carries one, what you are looking at is not where it
   * is, and the pane says where it is.** Without it, History would be the one place in the
   * product that shows mail somewhere other than its folder and does not admit to it.
   */
  const history = useMemo(
    /* MINUS ANYTHING INSIDE ITS UNDO WINDOW. History is built by `consentPartition` over the
       MIRROR's reader, so `presented`'s projection never reaches it — and a row held for delete
       stayed listed here for the whole window while the toast said it had moved (review finding).
       The subtraction is the same held set every other view is filtered by. */
    () => (consentView?.history ?? [])
      .filter((m) => !deleting.held.has(m.id))
      .map((m) => ({ ...m, physicalFolder: m.folder })),
    [consentView, deleting.held],
  );
  /**
   * EVERY MESSAGE IN THE MIRROR — what this device HOLDS, and NOT the first pull's numerator;
   * that is `pulled`, off `useMailState()`, because a windowed mirror pins this number at the
   * window's floor mid-import. Its remaining readers ask about the mirror itself.
   *
   * Read again here rather than lifted out of `useMailState`, because that context publishes the
   * count it was CONSTRUCTED with and this component is inside it; the two are the same
   * expression over the same reader at the same version, so they cannot disagree.
   */
  const mirroredCount = useMemo(() => reader.list("message").length, [reader, derived]);
  const tags = useMemo(() => reader.list<TagDTO>("tag"), [reader, derived]);
  /**
   * THE MAILBOX'S OWN FOLDERS — `folder` entities off `/sync` (FOLDERS-SPEC.md §4), present in
   * the mirror only while the account's "Use folders" flag is on, and gated AGAIN here on the
   * consent answer: the flag is the authority, the entities are data. A tab that has not yet
   * heard the flag renders the pre-feature rail; a tab whose mirror still holds entities after
   * the flag went off renders none. Both directions err towards today's interface.
   */
  const folders = useMemo(
    () => (consent.foldersEnabled ? reader.list<FolderEntity>("folder") : []),
    [reader, derived, consent.foldersEnabled],
  );

  /**
   * The account's PARTICIPATING mailboxes for the rail group's sections — what lets a mailbox
   * with zero folders still offer `+ New folder`. Participation is the per-mailbox dial
   * (spec §17: only the EXCEPTIONS travel) and the stood-down state: a `disabled` mailbox is
   * another organizer's, and a command Cloud's worker will never execute must not be offered.
   */
  const folderMailboxes = useMemo(
    () =>
      (facts ?? [])
        .filter((f) => f.status !== "disabled" && !(f.id in consent.folderMailboxesOff))
        .map((f) => ({ id: f.id, label: f.address })),
    [facts, consent.folderMailboxesOff],
  );
  /**
   * Per-folder unread, ONE PASS over the presented mirror — the tag counts' derivation and the
   * spec's "no server-side count column" decision. Keyed `mailboxId|path`; the rail rolls a
   * collapsed parent's descendants up from this same map, so there is one source and no second
   * number to drift.
   */
  const folderUnread = useMemo(
    () => (consent.foldersEnabled ? folderUnreadCounts(presented.list<EngineMessage>("message")) : new Map<string, number>()),
    [presented, derived, consent.foldersEnabled],
  );
  /** The open folder entity, and its mail — `tagGroup`'s twin, up here so every piece of route
   *  chrome (the rail highlight, the mobile title, the fallback view) derives from ONE answer
   *  to "does the folder the URL names exist". Absent ⇒ the Ohbox renders, and the chrome says
   *  so too. */
  const openFolder =
    route.view === "folder" ? folders.find((f) => f.id === route.folderId) : undefined;
  const folderMessages = useMemo(
    () =>
      openFolder
        ? presented
            .list<EngineMessage>("message")
            .filter((m) => m.mailboxId === openFolder.mailboxId && m.folder === openFolder.name)
            .sort((a, b) => {
              const at = a.date ? new Date(a.date).getTime() : 0;
              const bt = b.date ? new Date(b.date).getTime() : 0;
              return bt - at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
            })
        : [],
    [presented, derived, openFolder],
  );
  /** Every rule the consent gate has written, newest first. */
  const rules = useMemo(() => rulesList(reader), [reader, derived]);
  const mailboxes = useMemo(
    () => reader.list<MailboxEntity>("mailbox"),
    [reader, derived],
  );
  const draft = useMemo(
    () => reader.get<EngineDraft>("draft", "draft-compose") ?? null,
    [reader, derived],
  );
  const aiChip = useMemo(
    () => reader.get<ReadsAiChipEntity>("view_meta", "reads_ai_chip") ?? null,
    [reader, derived],
  );
  const account = useMemo(
    () => reader.get<{ email: string }>("view_meta", "account") ?? null,
    [reader, derived],
  );
  /** The demo's VIP block; `/sync` cannot emit `view_meta`, so a live account gets null. */
  const notifications = useMemo(
    () => reader.get<NotificationsMeta>("view_meta", "notifications") ?? null,
    [reader, derived],
  );

  /* The rows' MEMBERS, the three groups and the Older tail — see `ohbox-surface.ts`: a resurfaced
     conversation's unpinned members are in none of the groups, and a row `Load older` fetched is
     in none of them either, so a column resolved from the groups alone rested on "Nothing open."
     over a row on screen. */
  const allOhbox = useMemo(
    () => ohboxSurfaceMessages(resurfacedRows, ohbox, older.items),
    [resurfacedRows, ohbox, older.items],
  );
  /* WHAT THE RAIL COUNTS — the three groups, never the surface. The surface unions a resurfaced
     conversation's other members in so the column can resolve them, and one of those is the Sent
     copy of your own reply: counting it would make "N unread of M messages" say the Ohbox holds
     mail it does not list. */
  const ohboxCount = ohbox.resurfaced.length + ohbox.newForYou.length + ohbox.previouslySeen.length;
  /**
   * The conversation's people for a row's lead circles — bound to the
   * presented reader here (the views have no reader), mapped to
   * `{initials, hue}` with the same helpers every avatar uses. Built once
   * per version, not once per row: every mail list draws these circles, and
   * the per-thread selector's mirror scan would be O(mirror × rows) for a
   * decoration — one pass fills the map, a row's lookup is `Map.get`. The
   * empty answer is a shared constant so a thread with no people gives the
   * same array reference per render (a fresh `[]` defeats memos below).
   */
  const participantIndex = useMemo(() => {
    const out = new Map<string, { initials: string; hue: number }[]>();
    for (const [threadId, people] of threadParticipantsIndex(presented))
      out.set(
        threadId,
        people.map((a) => ({ initials: initialsOf(a.name || a.address), hue: avatarHue(a.address) })),
      );
    return out;
  }, [presented, derived]);
  const participantsOf = useStableCallback((threadId: string) => participantIndex.get(threadId) ?? NO_PARTICIPANTS);
  /**
   * HOW LONG EACH CONVERSATION IS — the same journey as the circles beside it, for the same
   * reason: the views have no reader, and a per-row walk of the mirror is O(mirror x rows) for a
   * capsule. The engine's index answers the server's own length where the thread row has synced,
   * so a windowed mirror holding three of nine does not put "3" on a row standing for nine.
   */
  const threadSizes = useMemo(() => threadSizeIndex(presented), [presented, derived]);
  const threadCountOf = useStableCallback((threadId: string) => threadSizes.get(threadId)?.count ?? 0);
  /**
   * THE CONVERSATION'S STORED NAME, for the Ohbox's grouped rows — bound here for the same
   * reason `participantsOf` is: the view has no reader of its own. The mirror's thread row
   * carries the subject the server named the thread with, prefixes already stripped, so the
   * grouped row says "Webshop" where its members say "Re: Webshop". `null` while the thread
   * row has not synced; the view falls back to the newest member's subject.
   */
  const threadSubjectOf = useStableCallback((threadId: string) => threadSubject(presented, threadId));

  /**
   * THE LAST-RESORT MAILBOX, MEMOIZED — it was read inline, so every render of this component
   * ran `sendingMailboxId`, which lists the mailboxes AND falls through to the whole mirror's
   * date order when the account has no seeded mailbox row (the desktop, and a Cloud tab before
   * its first poll — the two cases this fallback exists for). Twice per body publish, over the
   * whole mailbox. It answers from records, so the derived stamp is its whole dependency.
   */
  const fallbackMailboxId = useMemo(() => sendingMailboxId(reader), [reader, derived]);

  const drafts = useMemo(() => draftsList(reader), [reader, derived]);

  const scheduled = useMemo(() => scheduledSendsList(reader), [reader, derived]);

  return {
    ownAddresses,
    ownNameOf,
    mailboxLabelOf,
    consentView,
    presented,
    trashPage,
    trashWindow,
    older,
    folderOlder,
    ohbox,
    resurfacedRows,
    partition,
    receipts,
    receiptsPartition,
    piles,
    parked,
    tagGroups,
    windowedMirror,
    history,
    mirroredCount,
    tags,
    folders,
    folderMailboxes,
    folderUnread,
    openFolder,
    folderMessages,
    rules,
    mailboxes,
    draft,
    aiChip,
    account,
    notifications,
    allOhbox,
    ohboxCount,
    participantsOf,
    threadCountOf,
    threadSubjectOf,
    fallbackMailboxId,
    drafts,
    scheduled,
  };
}
