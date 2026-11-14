"use client";

/**
 * THE OPEN CONVERSATION AND ITS LETTERS' TEXT, read off the mounted engine. Each hook re-renders only for what it
 * draws: the conversation for any change of the mirror, a letter's text when that letter's body record moves.
 */
import type { EngineMessage, MessageBody } from "@ohmail/wire";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  BODY_FETCH_TIMEOUT_MS,
  bodyOf,
  isJunkHuskLeaving,
  isProtectedMessage,
  JUNK_REFILL_BOUND_MS,
  threadOf,
  threadSubject,
  type EntityReader,
  type OhmailEngine,
} from "@ohmail/client-engine";
import { useEngineOrNull } from "../engine/index.js";
import { useBodyArrival } from "../reading/body-arrival.js";
import { conversationOnScreen } from "../reading/conversation-on-screen.js";
import { usePresented } from "../reading/presented-mirror.js";
import { subscribeSessionRevival } from "../session/session-truth.js";

const NOTHING_TO_STOP = (): void => {};

/**
 * The engine's mirror and its change stamp, read again whenever it moves; null with no engine. The reader object
 * may stay the same while what it holds changes: a derivation keys on the stamp.
 */
export function useMirror(): { readonly mirror: EntityReader | null; readonly stamp: number } {
  const engine = useEngineOrNull();
  const subscribe = useCallback(
    (changed: () => void) => (engine === null ? NOTHING_TO_STOP : engine.subscribe(changed)),
    [engine],
  );
  const stamp = useSyncExternalStore(
    subscribe,
    () => (engine === null ? -1 : engine.read().version()),
    () => -1,
  );
  return { mirror: engine === null ? null : engine.read(), stamp };
}

/** What a column has for an opened id: its letters; a letter the engine tombstoned; or nothing yet. */
export type OpenState = "letters" | "gone" | "absent";

export interface ConversationShown {
  readonly state: OpenState;
  readonly opened: EngineMessage | null;
  /** Oldest first, each row as the lists present it where the presentation holds it. */
  readonly messages: EngineMessage[];
  /**
   * What the conversation is called: where several letters stand, its thread's own subject (the server names it with
   * the reply prefixes gone), the opened letter's own until that thread has synced; a single letter's own. Empty
   * with nothing opened.
   */
  readonly subject: string;
  /** The opened letter was read off the presented mirror: false where it holds no row of it. */
  readonly presented: boolean;
  /** The letters read off the presented mirror; any other one fails closed (it loads no picture by itself). */
  readonly presentedIds: ReadonlySet<string>;
}

/**
 * The letters a column shows for `openId`, oldest first: the conversation as the PRESENTED mirror has it (a reply the
 * presentation holds at the gate, a letter inside its delete window, are in no panel). Where the presentation holds
 * no row of the opened letter (a History row), the raw thread is read, and each member through the presentation
 * again: a member it holds is handed its presented row (its folder carries the hold), any other one goes as raw and
 * not presented. A letter neither holds is `gone` only
 * where the engine tombstoned it, else `absent` (not synced yet, or beyond this device).
 */
export function conversationShown(
  raw: EntityReader,
  presented: EntityReader,
  openId: string,
  isGone: (id: string) => boolean,
): ConversationShown {
  const shown = presented.get<EngineMessage>("message", openId) ?? null;
  const opened = shown ?? raw.get<EngineMessage>("message", openId) ?? null;
  if (opened === null)
    return {
      state: isGone(openId) ? "gone" : "absent",
      opened,
      messages: [],
      subject: "",
      presented: false,
      presentedIds: NONE,
    };
  const named = (messages: readonly EngineMessage[]): string =>
    messages.length > 1 && opened.threadId !== null
      ? (threadSubject(presented, opened.threadId) ?? opened.subject)
      : opened.subject;
  if (shown !== null) {
    const members = conversationOnScreen(presented, raw, openId);
    const messages = members.length > 0 ? members : [opened];
    return {
      state: "letters",
      opened,
      messages,
      subject: named(messages),
      presented: true,
      presentedIds: new Set(messages.map((m) => m.id)),
    };
  }
  const ids = new Set<string>();
  const members = threadOf(raw, openId).map((m) => {
    const row = presented.get<EngineMessage>("message", m.id);
    if (row === undefined) return m;
    ids.add(m.id);
    return row;
  });
  const messages = members.length > 0 ? members : [opened];
  return {
    state: "letters",
    opened,
    messages,
    subject: named(messages),
    presented: false,
    presentedIds: ids,
  };
}

const NONE: ReadonlySet<string> = new Set();

const NOTHING_OPEN: ConversationShown = {
  state: "absent",
  opened: null,
  messages: [],
  subject: "",
  presented: false,
  presentedIds: NONE,
};

/**
 * `own`: whether a letter is one this tab's own verbs took away (the ground's press seam keeps them); its tombstone is
 * the person's act, never another app's, and reads as a letter that is not here (`absent`), not as `gone`.
 */
export function useOpenConversation(openId: string | null, own: (id: string) => boolean): ConversationShown {
  const engine = useEngineOrNull();
  const { mirror, stamp } = useMirror();
  /* The mirror as the ground presents it: the column never reads the raw one in its place, and throws where no
     ground stands above. */
  const presented = usePresented();
  return useMemo(
    () =>
      mirror === null || engine === null || openId === null || stamp < 0
        ? NOTHING_OPEN
        : conversationShown(mirror, presented, openId, (id) => engine.messageIsGone(id) && !own(id)),
    [engine, mirror, presented, stamp, openId, own],
  );
}

/**
 * THE CONVERSATION'S BODIES, asked once for the whole conversation as today's reader asks: the opened letter urgent,
 * the siblings in one batch (protected ones too: the engine purges an old cached body for them rather than fetch).
 * The letters never ask themselves: a child's effect runs before its parent's and would send one request each first.
 */
export function useConversationBodies(openId: string | null, messages: readonly EngineMessage[]): void {
  const engine = useEngineOrNull();
  const siblings = messages
    .filter((m) => m.id !== openId)
    .map((m) => m.id)
    .join(",");
  useEffect(() => {
    if (engine === null || openId === null) return;
    void engine.hydrateBody(openId, { urgent: true });
  }, [engine, openId]);
  useEffect(() => {
    if (engine !== null && siblings !== "") void engine.hydrateThread(siblings.split(","));
  }, [engine, siblings]);
}

/** Read the body from the current mirror without starting a fetch or subscribing. */
export function readLetterBody(engine: Pick<OhmailEngine, "read">, message: EngineMessage): MessageBody {
  return bodyOf(engine.read(), message);
}

/**
 * One letter's text as `bodyOf` answers it, re-read when its body record lands. It asks nothing on its own
 * ({@link useConversationBodies} does), but a body that failed is asked once more on every new session.
 */
export function useLetterBody(message: EngineMessage, retryOnSession = true): MessageBody {
  const engine = useEngineOrNull();
  const id = message.id;
  /* Subscribed for the re-render alone: `bodyOf` reads the record itself. */
  useBodyArrival(id);
  const body = engine === null ? null : readLetterBody(engine, message);
  const failed = body?.state === "failed";
  useEffect(() => {
    if (engine === null || !failed || !retryOnSession) return;
    return subscribeSessionRevival(() => void engine.hydrateBody(id, { retry: true }));
  }, [engine, failed, id, retryOnSession]);
  return body === null
    ? {
        text: message.snippet,
        state: "snippet",
        html: null,
        loadedRemoteContent: false,
        unsubscribe: "no_header",
        unsubscribeUrl: null,
      }
    : body;
}

/** Read the body of a row verified by the store, keeping it only for the open letter's lifetime. */
export function useStoreLetterBody(message: EngineMessage | null) {
  const engine = useEngineOrNull();
  const id = message?.body === undefined && !isProtectedMessage(message) ? (message?.id ?? null) : null;
  const [attempt, retry] = useState(0);
  const [answer, setAnswer] = useState<{
    engine: NonNullable<typeof engine>;
    id: string;
    attempt: number;
    body: Awaited<ReturnType<NonNullable<typeof engine>["readBodyOffMirror"]>>;
  } | null>(null);
  useEffect(() => {
    if (id === null || engine === null || engine.messageIsGone(id)) return;
    let current = true;
    void engine.readBodyOffMirror(id).then((body) => {
      if (current && !engine.messageIsGone(id)) setAnswer({ engine, id, attempt, body });
    });
    return () => {
      current = false;
    };
  }, [engine, id, attempt]);
  const out =
    answer?.id === id && answer.engine === engine && answer.attempt === attempt ? answer.body : null;
  const askAgain = useCallback(() => retry((n) => n + 1), []);
  useEffect(() => {
    if (out?.state === "failed") return subscribeSessionRevival(askAgain);
  }, [out, askAgain]);
  if (message === null || id === null || engine === null) return null;
  const ready = out?.state === "ready" ? out : null;
  const full = ready !== null && ready.withheld === undefined;
  const body: MessageBody = {
    state: full ? "full" : ready?.withheld ? "withheld" : out === null ? "loading" : "failed",
    withheld: ready?.withheld,
    text: full ? ready.text : message.snippet,
    html: full ? ready.html : null,
    loadedRemoteContent: false,
    unsubscribe: "no_header",
    unsubscribeUrl: null,
  };
  return { body, retry: askAgain };
}

/** A letter returning from Junk can ask again once the mirror removes its withheld record. */
export function useJunkRefill(message: EngineMessage, body: MessageBody): boolean {
  const engine = useEngineOrNull();
  const id = message.id;
  const leaving = isJunkHuskLeaving(body, message.folder);
  const waiting = useRef<{ engine: typeof engine; id: string } | null>(null);
  const [expired, setExpired] = useState<string | null>(null);
  useEffect(() => {
    if (!leaving) return;
    setExpired(null);
    waiting.current = { engine, id };
    const timer = setTimeout(() => setExpired(id), JUNK_REFILL_BOUND_MS);
    return () => clearTimeout(timer);
  }, [engine, id, leaving]);
  useEffect(() => {
    if (leaving) return;
    const request = waiting.current;
    waiting.current = null;
    if (
      request?.id === id &&
      request.engine === engine &&
      (body.state === "snippet" || body.state === "loading")
    )
      void engine?.hydrateBody(id);
  }, [body.state, engine, id, leaving]);
  return leaving && expired === id;
}

/** Give a load time for its fetch, a slot's wait and the mirror's answer. */
export function useBodyStalled(messageId: string, waiting: boolean, attempt: number): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!waiting) return;
    const timer = setTimeout(() => setStalled(true), BODY_FETCH_TIMEOUT_MS * 2 + 3_000);
    return () => clearTimeout(timer);
  }, [messageId, waiting, attempt]);
  return waiting && stalled;
}
