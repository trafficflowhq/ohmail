import { useEffect, useRef } from "react";
import { filterOf, NONE_PRESSED, type Pressed } from "./facets.js";
import { folderKeyOf } from "./place-inventory.js";
import { dayBounds, type SearchNarrowing } from "./question.js";
import type { Translator } from "../text/translator.js";
import type { SearchListInput } from "./types.js";

export const SEARCH_LINK_FIELDS = [
  "q",
  "folder",
  "sender",
  "files",
  "who",
  "dir",
  "unread",
  "since",
  "until",
] as const;
type LinkWords = Readonly<Record<string, string>>;

export function filtersFromLink(words: LinkWords, t: Translator): Pressed {
  const { folder, sender, files } = words;
  if (!folder && !sender && files !== "1") return NONE_PRESSED;
  return [
    ...(folder
      ? [filterOf({ group: "folder", key: folderKeyOf(folder), raw: folder, exactPath: true }, t)]
      : []),
    ...(sender ? [filterOf({ group: "from", key: sender, raw: sender }, t)] : []),
    ...(files === "1" ? [filterOf({ group: "refine" }, t)] : []),
  ];
}

function linkedDay(day: string | undefined): string | null {
  return day !== undefined && dayBounds(day) !== null ? day : null;
}

export function narrowingFromLink(words: LinkWords): SearchNarrowing {
  const from = linkedDay(words.since);
  const to = linkedDay(words.until);
  return {
    person: words.who
      ? {
          address: words.who,
          name: null,
          dir: words.dir === "from" || words.dir === "to" ? words.dir : "any",
        }
      : null,
    unread: words.unread === "1",
    date: from === null && to === null ? null : { from, to },
  };
}

export function searchLink(query: string, pressed: Pressed, narrowing: SearchNarrowing): LinkWords {
  const { person, unread, date } = narrowing;
  return {
    q: query,
    folder: pressed.find((facet) => facet.group === "folder")?.raw ?? "",
    sender: pressed.find((facet) => facet.group === "from")?.raw ?? "",
    files: pressed.some((facet) => facet.group === "refine") ? "1" : "",
    who: person?.address ?? "",
    dir: person?.dir ?? "",
    unread: unread ? "1" : "",
    since: date?.from ?? "",
    until: date?.to ?? "",
  };
}

/** A filter change updates a shareable question without adding an entry to Back. */
export function useSearchFilterLink(
  { query, openId, onRefine }: SearchListInput,
  pressed: Pressed,
  narrowing: SearchNarrowing,
): void {
  const previous = useRef({ pressed, narrowing });
  useEffect(() => {
    if (previous.current.pressed === pressed && previous.current.narrowing === narrowing) return;
    previous.current = { pressed, narrowing };
    if (query.trim() || openId != null) onRefine?.(searchLink(query, pressed, narrowing));
  }, [pressed, narrowing, query, openId, onRefine]);
}
