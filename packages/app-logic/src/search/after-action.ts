import { useEffect, useRef } from "react";
import type { SearchHit } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import { ACTED_FRESH_MS } from "../press/after-verb.js";
import type { Slots } from "./slots.js";

interface SearchAfterAction {
  readonly openId: string | null | undefined;
  readonly question: string;
  readonly index: number;
  readonly length: number;
  readonly hitAt: Slots["hitAt"];
  readonly stillMatches: (message: EngineMessage) => boolean;
  readonly nextPage?: (index: number) => boolean;
  readonly open: (hit: SearchHit, entered: boolean) => void;
  readonly close?: () => void;
}

/** Follow a reader action from its original slot. A glance or a mailbox update does not start a walk. */
export function useSearchAfterAction(list: SearchAfterAction): (message: EngineMessage) => boolean {
  const acted = useRef<{
    message: EngineMessage;
    at: number;
    index: number;
    question: string;
    departed: boolean;
  } | null>(null);

  useEffect(() => {
    const last = acted.current;
    if (last === null) return;
    if (
      last.message.id !== list.openId ||
      last.question !== list.question ||
      (!last.departed && Date.now() - last.at > ACTED_FRESH_MS)
    ) {
      acted.current = null;
      return;
    }
    if (list.stillMatches(last.message)) {
      if (last.departed) acted.current = null;
      return;
    }
    last.departed = true;

    // A store removal leaves its slot empty. A device-only result can collapse into that slot.
    let index = last.index;
    for (; index < list.length; index++) {
      const hit = list.hitAt(index);
      if (hit === "gone") continue;
      if (hit === null) break;
      if (hit.message.id === last.message.id) continue;
      acted.current = null;
      list.open(hit, false);
      return;
    }
    if (list.nextPage?.(index)) return;
    acted.current = null;
    list.close?.();
  });

  const hit = list.openId == null ? null : list.hitAt(list.index);
  return (message) => {
    if (message.id !== list.openId) return false;
    if (!hit || hit === "gone" || hit.message.id !== message.id) return false;
    acted.current = {
      message: hit.message,
      at: Date.now(),
      index: list.index,
      question: list.question,
      departed: false,
    };
    return true;
  };
}
