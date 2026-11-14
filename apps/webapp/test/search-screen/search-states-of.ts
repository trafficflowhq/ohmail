/**
 * SEARCH'S STATES AS ADDRESSES: what each of the reference's keys asks of the states page (the question typed, the
 * person and the filters set, how the store answers, what is pressed once the answer stands), and the keys drawn.
 */

/** How the store answers the states page's question. */
export type StoreState =
  | "plain"
  | "empty"
  | "searching"
  | "atleast"
  | "about"
  | "synced"
  | "indexing"
  | "mirror"
  | "unanswered"
  | "failed"
  | "bounded"
  | "nostore";

export interface SearchState {
  /** The words in the field. */
  readonly query: string;
  readonly verdict: StoreState;
  /** The provider's Junk folder is named on an empty answer. */
  readonly junk: boolean;
  /** What a person pressed once the answer stood: the opener by its name, then the choice in what it opened. */
  readonly press: { readonly opener: string; readonly choice?: string } | null;
  /** The person set, by address, and their side. */
  readonly person: { readonly address: string; readonly dir: "any" | "from" | "to" } | null;
  readonly unread: boolean;
  /** The days set: a window ending today, or the two days the address names. */
  readonly date: { readonly window: "week" | "month" | "year" } | { readonly from: string; readonly to: string } | null;
}

const VERDICTS: Readonly<Record<string, StoreState>> = {
  searching: "searching",
  atleast: "atleast",
  about: "about",
  synced: "synced",
  indexing: "indexing",
  mirror: "mirror",
  unanswered: "unanswered",
  failed: "failed",
  bounded: "bounded",
  junk: "empty",
  part: "empty",
  depth: "empty",
};

export function searchStateOf(q: URLSearchParams): SearchState {
  const state = q.get("state");
  const who = q.get("who");
  const query = state === "empty" ? "" : (q.get("q") ?? (who !== null ? "" : "glaze"));
  const verdict: StoreState =
    (state !== null ? VERDICTS[state] : undefined) ??
    ((query === "" && who === null && q.get("unread") !== "1") || /pizza|@/.test(query) ? "empty" : "plain");
  const menu = q.get("menu");
  const press =
    q.get("where") === "ohbox"
      ? { opener: "Folder", choice: "Ohbox" }
      : menu === "where"
        ? { opener: "Folder" }
        : menu === "sort"
          ? { opener: "Sorted by" }
          : menu === "from"
            ? { opener: "From" }
            : menu === "date"
              ? { opener: "Date" }
              : q.get("all") === "1"
                ? { opener: "All" }
                : null;
  const dir = q.get("dir");
  const date = q.get("date");
  return {
    query,
    verdict,
    junk: state === "junk",
    press,
    person: who === null ? null : { address: who, dir: dir === "from" || dir === "to" ? dir : "any" },
    unread: q.get("unread") === "1",
    date:
      date === "week" || date === "month" || date === "year"
        ? { window: date }
        : date === "range"
          ? { from: q.get("since") ?? "", to: q.get("until") ?? "" }
          : null,
  };
}

/**
 * The keys this step draws (the screen's own, and the variants over one of them), as the reference's registry
 * spells them. `open=giulia-glaze` draws the list with that letter open; the reading column beside it is the
 * reader's, compared with the reader.
 */
export const SEARCH_KEYS: readonly string[] = [
  "screen=search&state=empty",
  "open=giulia-glaze&q=glaze&screen=search",
  "q=nadja%40erdton-atelier.example&screen=search",
  "q=glaze&screen=search&where=ohbox",
  "menu=where&q=glaze&screen=search",
  "menu=sort&q=glaze&screen=search",
  "q=pizza%20invoice&screen=search",
  ...[
    "searching",
    "atleast",
    "about",
    "synced",
    "reading",
    "indexing",
    "mirror",
    "unanswered",
    "failed",
    "bounded",
    "junk",
    "part",
    "depth",
    "first",
  ].map((state) => `q=invoice&screen=search&state=${state}`),
  "all=1&screen=search&state=empty",
  "screen=search&who=giulia%40terracotta-milano.example",
  "dir=from&q=kiln&screen=search&who=ben%40lichtgrat.example",
  "dir=to&screen=search&who=nadja%40erdton-atelier.example",
  "q=ben&screen=search",
  "q=kiln%20from%3Abe&screen=search",
  "menu=from&q=glaze&screen=search",
  "screen=search&state=empty&unread=1",
  "date=month&q=glaze&screen=search",
  "date=range&q=glaze&screen=search&since=2026-11-01&until=2026-11-10",
  "menu=date&q=glaze&screen=search",
  "device=phone&q=glaze&screen=search",
  "face=ohmarchy&open=giulia-glaze&q=glaze&screen=search",
  "open=giulia-glaze&q=glaze&scheme=dark&screen=search",
  "face=ohmarchy&open=giulia-glaze&q=glaze&scheme=dark&screen=search",
];

/**
 * The reference's keys of Search not drawn by this page, each with what draws it: an address's own view (the person
 * typed as an address: `AddressView`, a place of its own task).
 */
export const SEARCH_KEYS_ELSEWHERE: Readonly<Record<string, string>> = {
  "dir=all&screen=search&state=bysender&who=giulia%40terracotta-milano.example": "the address's own view (places)",
  "dir=to&screen=search&state=recent&who=nadja%40erdton-atelier.example": "the address's own view (places)",
  "dir=all&screen=search&state=cloudaway&who=giulia%40terracotta-milano.example": "the address's own view (places)",
  "dir=to&screen=search&state=noneto&who=petra%40makersfest.example": "the address's own view (places)",
};
