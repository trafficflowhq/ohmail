"use client";

/**
 * WHAT THE SERVER'S HANDSHAKE SAYS a page builds its host from: pairing, pictures and search, read from ONE
 * `GET /hello` per mount that asks ({@link serverHello} keeps no answer, so a page that needs several words reads them
 * here and hands them on rather than asking twice). Each word is `false` while pending, on an older server that does
 * not send it, on a failed hello and on the demo, which pays no round trip: a word the server has not said is the
 * safe answer (search sends `to` or `party` only where `searchPeople` reads true).
 */
import { useEffect, useState } from "react";
import { serverHello } from "./hello";

export interface ServerWords {
  readonly pairing: boolean;
  readonly remoteImages: boolean;
  /** Its search takes a person, unread and the days. */
  readonly searchPeople: boolean;
}
const SAYS_NOTHING: ServerWords = { pairing: false, remoteImages: false, searchPeople: false };

export function useServerWords(demo: boolean): ServerWords {
  const [words, setWords] = useState<ServerWords>(SAYS_NOTHING);
  useEffect(() => {
    if (demo) return;
    let alive = true;
    void serverHello().then((h) => {
      if (!alive) return;
      const pairing = h?.features?.pairing === true;
      const remoteImages = h?.features?.remoteImages === true;
      const searchPeople = h?.features?.searchPeople === true;
      setWords((was) =>
        was.pairing === pairing && was.remoteImages === remoteImages && was.searchPeople === searchPeople
          ? was
          : { pairing, remoteImages, searchPeople });
    });
    return () => {
      alive = false;
    };
  }, [demo]);
  return words;
}
