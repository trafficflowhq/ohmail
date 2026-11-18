"use client";

/**
 * WHAT THE GROUND HANDS THE ONE COMPOSER, read off the host, the frame and the pieces above it. This is the one place
 * a host's answers and the frame's route and commands become the composer's inputs, and nothing here can default:
 *
 * - THE DRAFT WIRE is the host's `wires.draftReply` and no other. Where the host answers `none` the composer is handed
 *   `none`: it answers no control, nothing can open an offer and nothing is asked. The ground has no wire of its own.
 * - WHOSE WORDS: the host's scope, pinned for the life of the mount. The frame mounts everything again under another
 *   scope, so a letter half written under one account is never read, saved or sent under another.
 * - THE MIRROR AS IT IS is what every send and save reads; the presented mirror is handed beside it, for the one
 *   press that reads where a letter is shown (Send + Done).
 * - WHAT IT SAYS leaves through the press seam's undo door, so the Undo of a Send + Done is the one `z` takes at any
 *   place; its own Done goes through the seam's dispatch.
 * - `route.view` IS `compose` EXACTLY WHILE THE PLACE `write` IS ON SCREEN. That is when the letter's autosave runs,
 *   and its fall is when the pending save is written: a mount that never said it would keep a letter in no draft.
 * - THE REPLY's OPEN LETTER is this mount's own state, for the frame's life. A change of place closes it, as it
 *   closes whatever else stood over the place left (its words are kept by the reply's own autosave, under the
 *   scope); a reply that opens WITH a walk rides the walk and is opened after it.
 * - A LETTER HANDED IN is taken once: the host's link (`signals.linkIn`, whose `take()` consumes it, so this is its
 *   one taker in a frame) and a letter a feature hands to `write` (`commands.write(draft)`). It is held under one
 *   identity until the composer has seeded it, because the composer takes each link once by identity.
 * - MAY A SEND LEAVE ITS EDITOR AT ONCE is the connection's health read at the press. Without it every send would
 *   wait in its editor.
 *
 * NOT HERE, and whose: the Reply Run (no place offers it on the ground yet: its cursor is none and its setters hold
 * nothing; its state becomes this mount's own with the place that draws the run); whether the account's balance was
 * last refused as empty (the Screener's model says it, and it stands in the ground with the Screener's own mount).
 */
import type { EngineMessage } from "@ohmail/wire";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OhmailEngine } from "@ohmail/client-engine";
import { useConsent, usePartition } from "@ohmail/app-logic/consent";
import { useDerivedVersion, useEngine, useSyncStatus } from "@ohmail/app-logic/engine";
import { useMailState } from "@ohmail/app-logic/mail-state";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { usePresented } from "@ohmail/app-logic/reading";
import { usePinnedScope } from "@ohmail/app-logic/storage/scope";
import type { Translator } from "@ohmail/app-logic/text/translator";
import { useComposerLists, type ComposerLists } from "@ohmail/app-logic/writing/composer-lists";
import type { ComposerPlace } from "@ohmail/app-logic/writing/composer-types";
import type { DraftReplyWire } from "@ohmail/app-logic/writing/draft-reply";
import { useMayHandOffFor } from "@ohmail/app-logic/writing/send-handoff";
import type { ShellComposeInput } from "@ohmail/app-logic/writing/shell-compose";
import {
  MAIL_HOME,
  isCalendarPlace,
  useFrame,
  useLinkedDraft,
  usePress,
  useSignal,
  type PlaceId,
} from "../../frame/index.js";
import { NONE, type LinkedDraft } from "../../host/index.js";
import { useTextLookup } from "../../text/index.js";
import { COMPOSER_WORDS } from "./writing-words.js";

/** The composer's three places, as the frame names them. */
const PLACE_OF: Readonly<Record<ComposerPlace, PlaceId>> = {
  compose: "write",
  drafts: "drafts",
  ohbox: MAIL_HOME,
};

/** A host that is never paired to another computer says nothing of that computer's silence. */
const NEVER_PAIRED = { read: () => null, subscribe: () => () => undefined };

/** No place offers the Reply Run on the ground yet: nothing is kept for it. */
const NO_RUN = (): void => undefined;

export interface WritingInputs {
  /** The composer's whole input record. */
  readonly composer: ShellComposeInput;
  readonly engine: OhmailEngine;
  /** Whose letters these are: the host's scope, pinned for the life of the mount. */
  readonly scope: string;
  /** The letter the reply stands under, or none. */
  readonly replyTo: string | null;
  /** The account's mailbox facts, or null while they cannot be seen. */
  readonly facts: MailboxFacts[] | null;
  readonly lists: ComposerLists;
  /** The whole catalogue's reader, as the composer is handed it. */
  readonly t: Translator;
}

/** The whole catalogue's reader, over the host's own text: a key names its namespace before the first dot. */
function useCatalogue(): Translator {
  const textOf = useTextLookup();
  return useMemo(
    (): Translator => (key, values) => {
      const dot = key.indexOf(".");
      return dot > 0 ? textOf(key.slice(0, dot))(key.slice(dot + 1), values as never) : "";
    },
    [textOf],
  );
}

interface Ways {
  /** The letter the reply stands under: this mount's own state, for the frame's life. */
  readonly replyTo: string | null;
  readonly setReplyTo: ShellComposeInput["setReplyTo"];
  readonly go: ShellComposeInput["go"];
  readonly showLetter: ShellComposeInput["showLetter"];
  readonly openWithReply: ShellComposeInput["openWithReply"];
  /** The place `write` is on screen. */
  readonly atWrite: boolean;
}

/**
 * The composer's three ways through the frame, and the reply's open letter. The frame's commands are one object while
 * the host stands, so each way is one function for the frame's life: the composer keeps `go` in an effect's list.
 */
function useWays(): Ways {
  const { host, route, plan, commands } = useFrame();
  /* Where the frame stands now, for a door pressed after this render. */
  const routeNow = useRef(route);
  routeNow.current = route;
  const columnsNow = useRef(plan.columns);
  columnsNow.current = plan.columns;
  const places = host.features.places;
  /** Whether the place on screen draws the shell's reading column: only there is a letter shown with its reply. */
  const readerHere = useCallback((): boolean => {
    const at = routeNow.current;
    if (isCalendarPlace(at.place)) return false;
    const entry = places[at.place];
    return entry !== NONE && entry.panes.kind === "columns" && entry.panes.Reading === "reader";
  }, [places]);

  const [replyTo, setReplyTo] = useState<string | null>(null);
  /** The letter whose reply rides the walk in progress; opened by the change of place, which closes any other. */
  const rides = useRef<string | null>(null);
  const spot = `${route.place}/${route.sub ?? ""}`;
  const lastSpot = useRef(spot);
  useEffect(() => {
    if (lastSpot.current === spot) return;
    lastSpot.current = spot;
    const carried = rides.current;
    rides.current = null;
    /* A ride opens only where its walk lands: a walk that never landed opens nothing at the next place. */
    setReplyTo(spot === `${MAIL_HOME}/` ? carried : null);
  }, [spot]);

  const go = useCallback(
    (to: ComposerPlace, how?: { readonly open: null }): void => {
      const place = PLACE_OF[to];
      const at = routeNow.current;
      /* Already there: the address is not written again (Back would then take two presses to leave). */
      if (at.place === place && at.stage === null) return;
      /* `open: null` named: the list is arrived at with no letter open, also where the place kept one. */
      commands.go(how === undefined ? { place } : { place, open: null });
    },
    [commands],
  );
  const showLetter = useCallback(
    (letter: string): void => {
      /* One column: the reading column is the open letter, so a reply under a letter that is not open would stand
         unseen. Only a place that draws the reader can show it. At two columns the reply stands where the person is. */
      if (columnsNow.current !== 1 || !readerHere()) return;
      if (routeNow.current.open !== letter) commands.open(letter);
    },
    [commands, readerHere],
  );
  const openWithReply = useCallback(
    (letter: EngineMessage): void => {
      const at = routeNow.current;
      if (readerHere() || at.place === MAIL_HOME) {
        /* It stays on this place: nothing will close the reply, so it opens now, with its letter. */
        setReplyTo(letter.id);
        if (at.open !== letter.id) commands.open(letter.id);
        return;
      }
      /* It walks to where a letter is read: the reply rides the walk, past the change of place that closes it. */
      rides.current = letter.id;
      commands.go({ place: MAIL_HOME, open: letter.id });
    },
    [commands, readerHere],
  );
  return { replyTo, setReplyTo, go, showLetter, openWithReply, atWrite: route.place === "write" };
}

/**
 * The letters handed in, in their order, each held under one identity until the composer says it has seeded it. A
 * queue, never one slot: a letter that arrives before the one ahead of it is seeded waits its turn.
 */
function useHandedLetter(atWrite: boolean): { link: LinkedDraft | null; seeded: () => void } {
  const linkIn = useFrame().host.signals.linkIn;
  const [queue, setQueue] = useState<readonly LinkedDraft[]>([]);
  /* Every letter this mount queued. The composer takes a letter once by its identity, so one handed again (waiting or
     seeded) would stand at the head unseeded and hold every letter behind it: it is dropped. */
  const queued = useRef(new WeakSet<LinkedDraft>());
  const enqueue = useCallback((letter: LinkedDraft): void => {
    if (queued.current.has(letter)) return;
    queued.current.add(letter);
    setQueue((q) => [...q, letter]);
  }, []);
  useEffect(() => {
    if (linkIn === NONE) return undefined;
    /* Taken once at mount and again on every arrival; a null answer changes nothing, so a double effect loses none. */
    const take = (): void => {
      const arrived = linkIn.take();
      if (arrived !== null) enqueue(arrived);
    };
    take();
    return linkIn.subscribe(take);
  }, [linkIn, enqueue]);
  /* A letter a feature handed to `write`: taken once, as the place stands. The taker is a new function a render, so
     this looks at every render while the place is on screen; it finds a letter once. */
  const takeHanded = useLinkedDraft();
  useEffect(() => {
    if (!atWrite) return;
    const handed = takeHanded();
    if (handed !== null) enqueue(handed);
  }, [atWrite, takeHanded, enqueue]);
  const seeded = useCallback(() => setQueue((q) => q.slice(1)), []);
  return { link: queue[0] ?? null, seeded };
}

export function useWritingInputs(): WritingInputs {
  const { host, route } = useFrame();
  const engine = useEngine();
  const derived = useDerivedVersion();
  /* The mirror as it is, read again when what is derived from it moved: every send and save reads this one. */
  const reader = engine.read();
  const press = usePress();
  const consent = useConsent();
  const { ownAddresses } = usePartition();
  const { state, mailboxes: facts } = useMailState();
  const presented = usePresented();
  const sync = useSyncStatus();
  const lists = useComposerLists(engine, reader, derived);
  const pinned = usePinnedScope(host.session.scope);
  /* Under `Scoped` the host's scope is an account's own: a refused scope mounts nothing of the ground. */
  if (pinned === null) throw new Error("the composer was mounted under no scope");
  const scope = pinned;
  const t = useCatalogue();
  const { replyTo, setReplyTo, go, showLetter, openWithReply, atWrite } = useWays();
  const { link, seeded } = useHandedLetter(atWrite);

  const paired = host.signals.hostConnection;
  const hostSilent = useSignal(paired === NONE ? NEVER_PAIRED : paired) !== null;
  const mayHandOffFor = useMayHandOffFor({
    stateKey: state.key,
    sync,
    hostOffline: hostSilent,
    engine,
    facts,
  });

  const own = useMemo(() => [...ownAddresses], [ownAddresses]);
  const view = useMemo(() => ({ view: atWrite ? "compose" : route.place }), [atWrite, route.place]);
  const composer: ShellComposeInput = {
    engine,
    reader,
    t,
    words: COMPOSER_WORDS,
    toast: press.undoToast,
    /* As the host says it, `none` included. The one cast: the contract names the wire's answers opaquely, and their
       one declaration is the drafter's own. */
    draftReplyWire: host.wires.draftReply as unknown as DraftReplyWire | typeof NONE,
    route: view,
    go,
    showLetter,
    openWithReply,
    consent,
    facts,
    mailboxes: lists.mailboxes,
    drafts: lists.drafts,
    ownAddresses: own,
    fallbackMailboxId: lists.fallbackMailboxId,
    replyTo,
    setReplyTo,
    fr: null,
    setFr: NO_RUN,
    setFrDone: NO_RUN,
    setFrValues: NO_RUN,
    presented,
    mutateAndReport: press.mutateAndReport,
    toastWithUndo: press.toastWithUndo,
    mailtoDraft: link,
    onMailtoDraftSeeded: seeded,
    mayHandOffFor,
    scope,
  };
  return { composer, engine, scope, replyTo, facts, lists, t };
}
