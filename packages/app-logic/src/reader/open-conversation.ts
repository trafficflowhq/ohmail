"use client";

/**
 * THE OPEN CONVERSATION AND ITS LETTERS' TEXT, read off the mounted engine. Each hook re-renders only for what it
 * draws: the conversation for any change of the mirror, a letter's text when that letter's body record moves.
 */
import type { EngineMessage, MessageBody } from "@ohmail/wire";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { bodyOf, threadOf, threadSubject, type EntityReader } from "@ohmail/client-engine";
import { useEngineOrNull } from "../engine/index.js";
import { useBodyArrival } from "../reading/body-arrival.js";
import { conversationOnScreen } from "../reading/conversation-on-screen.js";
import { usePresentedMirror } from "../reading/presented-mirror.js";
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
  /** The opened letter was read off the presented mirror: false where no shell handed one, or it holds no row of it. */
  readonly presented: boolean;
  /** The letters read off the presented mirror; any other one fails closed (it loads no picture by itself). */
  readonly presentedIds: ReadonlySet<string>;
}

/**
 * The letters a column shows for `openId`, oldest first: the conversation as the PRESENTED mirror has it (a reply the
 * presentation holds at the gate, a letter inside its delete window, are in no panel). Where the presentation holds
 * no row of the opened letter (a History row), the raw thread is read, and each member through the presentation
 * again: a member it holds is handed its presented row (its folder carries the hold), any other one goes as raw and
 * not presented. With no presented mirror, the raw one, nothing presented. A letter neither holds is `gone` only
 * where the engine tombstoned it, else `absent` (not synced yet, or beyond this device).
 */
export function conversationShown(
  raw: EntityReader,
  presented: EntityReader | null,
  openId: string,
  isGone: (id: string) => boolean,
): ConversationShown {
  const shown = presented?.get<EngineMessage>("message", openId) ?? null;
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
      ? (threadSubject(presented ?? raw, opened.threadId) ?? opened.subject)
      : opened.subject;
  if (presented === null) {
    const members = threadOf(raw, openId);
    const messages = members.length > 0 ? members : [opened];
    return {
      state: "letters",
      opened,
      messages,
      subject: named(messages),
      presented: false,
      presentedIds: NONE,
    };
  }
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

export function useOpenConversation(openId: string | null): ConversationShown {
  const engine = useEngineOrNull();
  const { mirror, stamp } = useMirror();
  const presented = usePresentedMirror();
  return useMemo(
    () =>
      mirror === null || engine === null || openId === null || stamp < 0
        ? NOTHING_OPEN
        : conversationShown(mirror, presented, openId, (id) => engine.messageIsGone(id)),
    [engine, mirror, presented, stamp, openId],
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

/**
 * One letter's text as `bodyOf` answers it, re-read when its body record lands. It asks nothing on its own
 * ({@link useConversationBodies} does), but a body that failed is asked once more on every new session.
 */
export function useLetterBody(message: EngineMessage): MessageBody {
  const engine = useEngineOrNull();
  const id = message.id;
  /* Subscribed for the re-render alone: `bodyOf` reads the record itself. */
  useBodyArrival(id);
  const body = engine === null ? null : bodyOf(engine.read(), message);
  const failed = body?.state === "failed";
  useEffect(() => {
    if (engine === null || !failed) return;
    return subscribeSessionRevival(() => void engine.hydrateBody(id, { retry: true }));
  }, [engine, failed, id]);
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
