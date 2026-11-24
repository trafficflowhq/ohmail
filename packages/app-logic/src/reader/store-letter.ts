"use client";

/**
 * A LETTER THE MIRROR'S WINDOW NO LONGER HOLDS IS THE STORE'S TO ANSWER. The open letter lives in the address, so a
 * reload, a copied link or a restored tab names an id; where the mirror does not hold it (the window evicted it) and
 * the engine never tombstoned it, the store is asked for that one letter by id (`engine.fetchMessage`), once a drain
 * has filled the mirror (before that, the drain may still bring it). Its answer: the letter, opened off the mirror
 * and never written into it; `missing`: no store holds it (a link from another account's mirror, mail the server no
 * longer has), and the claim is the column's to drop. Where no store lookup stands (`unavailable`: a host with no
 * such door) the reader can fall back to the pressed Search result, or drop an unanswered link. A failed ask or
 * a reply for another id leaves the column as it stands.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useContext, useEffect, useRef, useState } from "react";
import { EngineContext } from "../engine/context.js";

export type StoreLetter =
  | { readonly state: "none" }
  | { readonly state: "asking" }
  | { readonly state: "found"; readonly message: EngineMessage }
  | { readonly state: "missing" | "unavailable" };

const NONE: StoreLetter = { state: "none" };
const ASKING: StoreLetter = { state: "asking" };
const MISSING: StoreLetter = { state: "missing" };

/** The store's answer for `openId`, asked while `absent` (the mirror holds no row of it and never tombstoned it). */
export function useStoreLetter(openId: string, absent: boolean, verified?: EngineMessage): StoreLetter {
  const binding = useContext(EngineContext);
  const engine = binding?.engine ?? null;
  const known = useRef(verified);
  known.current = verified;
  const listed = verified?.id === openId || engine?.storePageRowById(openId) !== undefined;
  /* A drain has filled the mirror and it holds mail: a mirror still filling, or empty before its first rows land
     (a world settled before its letters), is no answer that the letter is beyond it. */
  const ask =
    absent &&
    engine !== null &&
    binding !== null &&
    (listed || (!binding.sync.bootstrapping && engine.read().list("message").length > 0)) &&
    !engine.messageIsGone(openId);
  const [answer, setAnswer] = useState<{ readonly id: string; readonly letter: StoreLetter } | null>(null);
  useEffect(() => {
    if (!ask || engine === null) return undefined;
    let here = true;
    setAnswer({ id: openId, letter: ASKING });
    const pageRow = known.current?.id === openId ? known.current : engine.storePageRowById(openId);
    void engine.fetchMessage(openId).then((out) => {
      if (!here || engine.messageIsGone(openId)) return;
      const fallback = out.state === "unavailable" && pageRow ? engine.storePageRow(pageRow) : null;
      setAnswer({
        id: openId,
        letter:
          out.state === "ready" && out.message.id === openId
            ? { state: "found", message: out.message }
            : fallback !== null
              ? { state: "found", message: fallback }
              : out.state === "missing"
                ? MISSING
                : out.state === "unavailable"
                  ? { state: "unavailable" }
                  : NONE,
      });
    });
    return () => {
      here = false;
    };
  }, [ask, engine, openId]);
  if (!absent || answer === null || answer.id !== openId) return NONE;
  return answer.letter;
}
