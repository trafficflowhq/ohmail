"use client";

/**
 * WHAT THE SERVER'S HANDSHAKE SAYS a page builds its host from: pairing, pictures and search, read from ONE
 * `GET /hello` per mount that asks, until it answers ({@link serverHello} keeps no answer, so a page that needs
 * several words reads them here and hands them on rather than asking twice). Mail capabilities are `false` while pending, on
 * an older server that does not send it, on a failed hello and on the demo, which pays no round trip: a word the
 * server has not said is the safe answer (search sends `to` or `party` only where `searchPeople` reads true).
 */
import { useEffect, useState } from "react";
import { serverHello } from "./hello";

export interface ServerWords {
  readonly pairing: boolean;
  readonly remoteImages: boolean;
  /** Its search takes a person, unread and the days. */
  readonly searchPeople: boolean;
  /** Null while the handshake can still answer an incoming Calendar link. */
  readonly calendar: boolean | null;
}
const SAYS_NOTHING: ServerWords = { pairing: false, remoteImages: false, searchPeople: false, calendar: null };

/** How long a page waits before it asks again after an ask that got no answer. */
const ASK_AGAIN_AFTER_MS = 30_000;
/** How many times a page asks again after an ask that got no answer. */
const ASK_AGAIN_AT_MOST = 3;

/**
 * The handshake's words a page builds its host from, read once. An ask that got no answer (`null`: a failed request,
 * the deadline) is asked again on the window's next `online` event or after 30 seconds, whichever comes first, at most
 * three times: else a page whose first ask failed would offer no pictures, no Devices and no search by a person
 * for its life.
 */
export function useServerWords(demo: boolean): ServerWords {
  const [words, setWords] = useState<ServerWords>(SAYS_NOTHING);
  useEffect(() => {
    if (demo) return;
    let alive = true;
    let again = 0;
    let disarm = (): void => undefined;
    const ask = (): void => {
      void serverHello().then((h) => {
        if (!alive) return;
        const pairing = h?.features?.pairing === true;
        const remoteImages = h?.features?.remoteImages === true;
        const searchPeople = h?.features?.searchPeople === true;
        const retrying = h === null && again < ASK_AGAIN_AT_MOST;
        const calendar = retrying ? null : h?.features?.calendar === true;
        setWords((was) =>
          was.pairing === pairing && was.remoteImages === remoteImages && was.searchPeople === searchPeople && was.calendar === calendar
            ? was
            : { pairing, remoteImages, searchPeople, calendar });
        if (!retrying) return;
        again += 1;
        const askAgain = (): void => {
          disarm();
          ask();
        };
        const timer = setTimeout(askAgain, ASK_AGAIN_AFTER_MS);
        window.addEventListener("online", askAgain);
        disarm = () => {
          clearTimeout(timer);
          window.removeEventListener("online", askAgain);
          disarm = () => undefined;
        };
      });
    };
    ask();
    return () => {
      alive = false;
      disarm();
    };
  }, [demo]);
  return words;
}
