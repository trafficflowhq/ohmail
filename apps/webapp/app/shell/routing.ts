"use client";

/**
 * Hash routing, verbatim from the prototype's contract:
 *   #/ohbox … #/settings   the eight views
 *   #/screener/screened    screener segment deep-links
 *   #/tag/pottery          one tag across everything
 * The query string (?demo=1) is untouched by navigation.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

export const VIEWS = [
  "ohbox",
  "reads",
  "receipts",
  "screener",
  "triage",
  /**
   * HISTORY — mail from senders nobody has ever decided about, that went quiet long ago.
   *
   * Not "archive". Archive is a VERB in every other mail client, an action this mail never
   * received, and plenty of mailboxes have a real server-side Archive folder whose contents
   * this view is not showing.
   *
   * It sits after the piles and before the utilities because it is a place mail is, rather
   * than a tool — but it is deliberately NOT one of `PILE_IDS`, so the number keys skip it.
   */
  "history",
  "search",
  "compose",
  /**
   * DRAFTS — the messages you started and have not sent.
   *
   * Beside Compose rather than among the piles, because it is not a place mail ARRIVED: every
   * row is something this account wrote. It is deliberately not one of `PILE_IDS`, so the number
   * keys skip it, for the same reason History is not.
   */
  "drafts",
  "settings",
] as const;
export type ViewId = (typeof VIEWS)[number] | "tag";
export type ScreenerSegmentId = "waiting" | "screened" | "spam";
/**
 * WHICH TRIAGE PILE IS OPEN — the thing the route could not say.
 *
 * Reported as: the triage horizons cannot be selected individually, only Answer Later opens,
 * on all three. That was exact. The rail lists three rows — Answer Later, Park, Resurface —
 * and `AppShell` collapsed every id beginning `triage` into `go("triage")`, which is a route
 * with no pile in it at all; `TriageView` then rendered all three stacks as equal peers and
 * `activeRailId` mapped the view back to the literal id `"triage"`, which is the Answer Later
 * row. So all three rows navigated to the identical URL, showed the identical screen, and lit
 * the first row whichever had been clicked. Selecting Park was not merely unbound — it was
 * unrepresentable.
 *
 * The ids are the pile's own names and not the rail's (`triage-aside`), because this is what
 * the URL carries: `#/triage/aside` reads as a place, `#/triage/triage-aside` reads as a bug.
 */
export const TRIAGE_PILES = ["reply", "aside", "resurface"] as const;
export type TriagePileId = (typeof TRIAGE_PILES)[number];

export interface Route {
  view: ViewId;
  tagId: string | null;
  screenerSegment: ScreenerSegmentId;
  triagePile: TriagePileId;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  if (raw.startsWith("tag/") && raw.slice(4)) {
    return { view: "tag", tagId: raw.slice(4), screenerSegment: "waiting", triagePile: "reply" };
  }
  if (raw === "screener" || raw.startsWith("screener/")) {
    const sub = raw.split("/")[1];
    return {
      view: "screener",
      tagId: null,
      screenerSegment: sub === "screened" || sub === "spam" ? sub : "waiting",
      triagePile: "reply",
    };
  }
  // `#/triage`, `#/triage/aside`, `#/triage/resurface`. An unknown sub-path falls to the first
  // pile rather than 404ing, exactly as an unknown screener segment falls to `waiting`.
  if (raw === "triage" || raw.startsWith("triage/")) {
    const sub = raw.split("/")[1];
    return {
      view: "triage",
      tagId: null,
      screenerSegment: "waiting",
      triagePile: (TRIAGE_PILES as readonly string[]).includes(sub ?? "")
        ? (sub as TriagePileId)
        : "reply",
    };
  }
  const view = (VIEWS as readonly string[]).includes(raw) ? (raw as ViewId) : "ohbox";
  return { view, tagId: null, screenerSegment: "waiting", triagePile: "reply" };
}

/**
 * The canonical hash for a route — `parseHash`'s inverse, spelled the way the `go*` helpers
 * spell it (`#/triage` for the first pile, `#/screener` for waiting), so a rewrite can never
 * mint a form navigation itself would not produce.
 */
export function canonicalHash(route: Route): string {
  if (route.view === "tag") return `#/tag/${route.tagId}`;
  if (route.view === "screener")
    return route.screenerSegment === "waiting" ? "#/screener" : `#/screener/${route.screenerSegment}`;
  if (route.view === "triage")
    return route.triagePile === "reply" ? "#/triage" : `#/triage/${route.triagePile}`;
  return `#/${route.view}`;
}

/**
 * The hash the address bar SHOULD carry for what the deck is showing, or `null` when it
 * already does.
 *
 * `parseHash` answers an unknown hash with the Ohbox — the right screen — but the URL kept
 * the bogus fragment, so `#/bogus` sat in the bar over a rendered Ohbox: a link that
 * reproduces nothing and a reload that silently "works". The empty hash is left alone — a
 * bare `/` is how every session begins, and stamping `#/ohbox` onto it would rewrite the URL
 * of a page nobody navigated yet.
 */
export function normalizedHash(hash: string): string | null {
  if (hash === "" || hash === "#") return null;
  const canonical = canonicalHash(parseHash(hash));
  return canonical === hash ? null : canonical;
}

export function useHashRoute(): Route {
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("hashchange", cb);
    return () => window.removeEventListener("hashchange", cb);
  }, []);
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
  /**
   * KEEP THE ADDRESS BAR HONEST — the URL says what is on screen. An unknown hash renders
   * the Ohbox (the fallback in `parseHash`), and this rewrites the fragment to match, so a
   * copied link and a reload land where the user is actually looking. `replaceState`, not
   * an assignment to `location.hash`: the bogus entry is corrected in place rather than
   * buried one Back-press deep — and it fires no `hashchange`, which is fine because the
   * rendered route is already the fallback the rewrite spells out.
   */
  useEffect(() => {
    const next = normalizedHash(hash);
    if (next != null) window.history.replaceState(window.history.state, "", next);
  }, [hash]);
  return useMemo(() => parseHash(hash), [hash]);
}

export function go(view: Exclude<ViewId, "tag">): void {
  window.location.hash = `#/${view}`;
}

export function goTag(tagId: string): void {
  window.location.hash = `#/tag/${tagId}`;
}

export function goScreener(segment: ScreenerSegmentId): void {
  window.location.hash = segment === "waiting" ? "#/screener" : `#/screener/${segment}`;
}

/** The first pile keeps the bare `#/triage`, so every link that already exists still lands. */
export function goTriage(pile: TriagePileId): void {
  window.location.hash = pile === "reply" ? "#/triage" : `#/triage/${pile}`;
}
