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

/**
 * THE SETTINGS PANES, and why the ROUTER owns the list now.
 *
 * `#/settings/<pane>` is a route segment: a settings section is a place — loadable directly,
 * walkable with Back/Forward — and the router must validate it the way it validates a
 * screener segment or a triage pile: an unknown sub-path falls back rather than 404ing, and
 * `normalizedHash` then rewrites the bar to the spelling that reproduces what is on screen. The
 * list lived in `SettingsView` (it predates the segment; `?settings=<pane>` was its one
 * consumer), but a copy in each file is two lists one new pane apart from disagreeing — so the
 * view re-exports THIS one. Which panes EXIST on a given surface is still the view's per-surface
 * clamp; this list is only "what may a URL say".
 */
export const PANE_IDS = [
  "general", "notifications", "mailboxes", "screener", "away", "billing", "invites", "tags", "rules",
  "about", "security", "account", "desktop", "devices",
] as const;
export type PaneId = (typeof PANE_IDS)[number];

export interface Route {
  view: ViewId;
  tagId: string | null;
  screenerSegment: ScreenerSegmentId;
  triagePile: TriagePileId;
  /**
   * WHICH SETTINGS PANE THE URL NAMES — or `null`, and `null` is load-bearing: it means the hash
   * did not say. A bare `#/settings` (every pre-existing link, and the `go("settings")` every
   * rail click makes) leaves the pane to the view's own deep-link logic — the `?settings=<pane>`
   * query the OAuth return uses — where an explicit `#/settings/devices` overrides it. Folding
   * both into one default here would make clicking "General" indistinguishable from never having
   * chosen, and the query would win an argument the user just settled.
   */
  settingsPane: PaneId | null;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  if (raw.startsWith("tag/") && raw.slice(4)) {
    return { view: "tag", tagId: raw.slice(4), screenerSegment: "waiting", triagePile: "reply", settingsPane: null };
  }
  if (raw === "screener" || raw.startsWith("screener/")) {
    const sub = raw.split("/")[1];
    return {
      view: "screener",
      tagId: null,
      screenerSegment: sub === "screened" || sub === "spam" ? sub : "waiting",
      triagePile: "reply",
      settingsPane: null,
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
      settingsPane: null,
    };
  }
  // `#/settings`, `#/settings/devices`, … A named pane is validated against `PANE_IDS`; an
  // unknown sub-path falls back to the BARE form (`settingsPane: null`, the view's own
  // deep-link logic), exactly as an unknown screener segment falls to `waiting` — and
  // `normalizedHash` then rewrites `#/settings/bogus` to `#/settings` so the bar stays honest.
  if (raw === "settings" || raw.startsWith("settings/")) {
    const sub = raw.split("/")[1];
    return {
      view: "settings",
      tagId: null,
      screenerSegment: "waiting",
      triagePile: "reply",
      settingsPane: (PANE_IDS as readonly string[]).includes(sub ?? "") ? (sub as PaneId) : null,
    };
  }
  const view = (VIEWS as readonly string[]).includes(raw) ? (raw as ViewId) : "ohbox";
  return { view, tagId: null, screenerSegment: "waiting", triagePile: "reply", settingsPane: null };
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
  // BOTH spellings are canonical for settings: bare (`settingsPane: null` — the pane is the
  // view's deep-link logic's to decide) and named. Only an UNKNOWN sub-path normalizes, to bare.
  if (route.view === "settings")
    return route.settingsPane === null ? "#/settings" : `#/settings/${route.settingsPane}`;
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

/**
 * ALWAYS the named form — `#/settings/general`, never bare — because this is what a CHOICE
 * writes. The bare form means "the pane is the deep-link logic's to decide" (see
 * {@link Route.settingsPane}), and a person who just clicked General has decided: spelling
 * their click as the bare hash would hand the decision straight back to a `?settings=` query
 * that may still be in the address bar. Each call is a hash ASSIGNMENT, so sections stack in
 * history and Back/Forward walk them.
 */
export function goSettings(pane: PaneId): void {
  window.location.hash = `#/settings/${pane}`;
}
