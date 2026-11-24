/**
 * WHAT THE OHBOX READS OFF THE PRESENTED MIRROR: its three groups, the resurfaced conversations, every message it
 * can show, the tags, and each conversation's people, length, squares and stored name. One pass each, made again
 * when the mirror moves.
 */
import type { EngineMessage, TagEntity as TagDTO } from "@ohmail/wire";
import { useMemo } from "react";
import {
  ohboxView,
  resurfacedThreads,
  threadMarksIndex,
  threadParticipantsIndex,
  threadSizeIndex,
  threadSubject,
  type OhboxView,
  type ResurfacedThreadRow,
} from "@ohmail/client-engine";
import { atStamp as at, useDerivedVersion, useEngine } from "../engine/context.js";
import { useStableCallback } from "../press/stable-callback.js";
import { conversationOnScreen } from "../reading/conversation-on-screen.js";
import { ohboxSurfaceMessages } from "../reading/ohbox-surface.js";
import { usePresented } from "../reading/presented-mirror.js";
import { avatarHue, initialsOf } from "../text/format.js";
import type { OhboxListInput } from "./types.js";

export interface OhboxMirror {
  readonly ohbox: OhboxView;
  readonly resurfacedRows: ResurfacedThreadRow[];
  /** Every message the Ohbox can show. It offers no older tail: its end leads to History. */
  readonly surface: EngineMessage[];
  readonly tags: TagDTO[];
}

export function useOhboxMirror(): OhboxMirror {
  const engine = useEngine();
  const presented = usePresented(); // throws where no ground stands above
  const derived = useDerivedVersion();
  /* The row being read keeps its conversation in New until it is left or answered: the engine holds it, and the
     held id is a key of the memo itself. */
  const openHeld = engine.openRowHeld();
  const ohbox = useMemo(() => at(derived, ohboxView(presented, openHeld)), [presented, derived, openHeld]);
  const resurfacedRows = useMemo(() => at(derived, resurfacedThreads(presented)), [presented, derived]);
  const surface = useMemo(() => ohboxSurfaceMessages(resurfacedRows, ohbox, []), [resurfacedRows, ohbox]);
  const tags = useMemo(() => at(derived, engine.read().list<TagDTO>("tag")), [engine, derived]);
  return { ohbox, resurfacedRows, surface, tags };
}

const NO_PARTICIPANTS: { initials: string; hue: number }[] = [];

/** The conversation's people, length, squares and stored name for a row, and the conversation a letter stands in. */
export function useThreadFacts(): Pick<
  OhboxListInput,
  "threadParticipants" | "threadCountOf" | "threadMarksOf" | "threadSubject" | "conversationOf"
> {
  const engine = useEngine();
  const presented = usePresented();
  const derived = useDerivedVersion();
  const people = useMemo(() => {
    const out = new Map<string, { initials: string; hue: number }[]>();
    for (const [threadId, list] of at(derived, threadParticipantsIndex(presented)))
      out.set(
        threadId,
        list.map((a) => ({ initials: initialsOf(a.name || a.address), hue: avatarHue(a.address) })),
      );
    return out;
  }, [presented, derived]);
  const sizes = useMemo(() => at(derived, threadSizeIndex(presented)), [presented, derived]);
  const marks = useMemo(() => at(derived, threadMarksIndex(presented)), [presented, derived]);
  /* A new asker whenever the mirror moves: what the list keeps of a row's people is the mirror's as it stands. */
  const conversationOf = useMemo(
    () => at(derived, (messageId: string) => conversationOnScreen(presented, engine.read(), messageId)),
    [presented, engine, derived],
  );
  return {
    threadParticipants: useStableCallback((threadId: string) => people.get(threadId) ?? NO_PARTICIPANTS),
    threadCountOf: useStableCallback((threadId: string) => sizes.get(threadId)?.count ?? 0),
    threadMarksOf: useStableCallback((threadId: string) => marks.get(threadId)),
    threadSubject: useStableCallback((threadId: string) => threadSubject(presented, threadId)),
    conversationOf,
  };
}
