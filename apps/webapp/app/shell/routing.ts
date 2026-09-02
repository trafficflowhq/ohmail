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
/**
 * `"tag"` and `"folder"` are parameterized views — one tag, or one of the mailbox's own folders,
 * across the URL as `#/tag/<id>` / `#/folder/<id>`. The folder id is the `folder` entity's id
 * (an opaque row id), never the path: a canonical path contains `/`, which would collide with
 * the `m/<messageId>` tail this router splits first.
 */
export type ViewId = (typeof VIEWS)[number] | "tag" | "folder";
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
  "folders", "signatures", "about", "security", "account", "desktop", "devices",
] as const;
export type PaneId = (typeof PANE_IDS)[number];

/**
 * THE VIEWS WHOSE URL MAY NAME AN OPEN MESSAGE — everything that can show one. Settings and
 * Compose have no message to open; Drafts opens a COMPOSE (its rows are the account's own
 * unsent mail), and the Screener's rows are SENDERS, not messages, so a message id says
 * nothing its list can locate. A `m/<id>` tail on any of the excluded views normalizes away.
 */
const MESSAGE_VIEWS: readonly string[] = ["ohbox", "reads", "receipts", "history", "search", "tag", "folder", "triage"];

/**
 * Split a raw hash path from its `m/<id>` tail — the OPEN MESSAGE, when the URL names one.
 * The marker segment is what keeps a message id from ever colliding with a named segment
 * (`#/screener/screened`, `#/settings/devices`, a tag named "m" notwithstanding — a tag path
 * is `tag/<id>` with exactly one segment, so `tag/m/x` reads as tag "m/x"? No: the tail is
 * split FIRST, so `#/tag/pottery/m/<id>` is the tag "pottery" with a message open, and a bare
 * `#/tag/m` stays the tag named "m". Two segments, always at the end, always `m` then the id.)
 */
function splitMessageTail(raw: string): { path: string; messageId: string | null } {
  const parts = raw.split("/");
  if (parts.length >= 3 && parts[parts.length - 2] === "m" && parts[parts.length - 1]) {
    return { path: parts.slice(0, -2).join("/"), messageId: parts[parts.length - 1]! };
  }
  return { path: raw, messageId: null };
}

export interface Route {
  view: ViewId;
  tagId: string | null;
  /** The open folder's entity id when `view === "folder"` — `tagId`'s twin, `null` elsewhere. */
  folderId: string | null;
  screenerSegment: ScreenerSegmentId;
  triagePile: TriagePileId;
  /**
   * THE OPEN MESSAGE, when the URL names one — `#/<view>/m/<messageId>`, on the views that can
   * show a message (see {@link MESSAGE_VIEWS}). `null` is a URL about a place, not a reading.
   *
   * What the id means is the SHELL's to apply (`AppShell`'s route↔open-state mirror): the URL
   * is a claim about what is on screen, so a reload restores the open message, Back walks out
   * of it, and a link hands somebody the exact reading. The router only carries it — an id the
   * mirror does not hold falls back in the shell, never 404s here, exactly as every other
   * unknown segment falls back.
   */
  messageId: string | null;
  /**
   * WHICH SETTINGS PANE THE URL NAMES — or `null`, and `null` is load-bearing: it means the hash
   * did not say. A bare `#/settings` (every pre-existing link, and the `go("settings")` every
   * rail click makes) leaves the pane to the view's own deep-link logic — the `?settings=<pane>`
   * query the OAuth return uses — where an explicit `#/settings/devices` overrides it. Folding
   * both into one default here would make clicking "General" indistinguishable from never having
   * chosen, and the query would win an argument the user just settled.
   */
  settingsPane: PaneId | null;
  /**
   * IS THE FIRST-RUN STAGE OPEN — `#/first-run`, and the one route field that is not about
   * WHICH VIEW is showing.
   *
   * The stage is a dialog OVER the app, so it rides beside {@link view} instead of replacing
   * it: `#/first-run` parses to the Ohbox with this set, the shell renders both, and leaving
   * the stage is a hash write that changes nothing else on screen. A `ViewId` member would have
   * put setup in the rail, in the number keys, and in every `go()` call's type.
   *
   * ── THE NAME IS `first-run` AND NOT `setup`, DELIBERATELY ─────────────────────────────────
   *
   * `apps/webapp` already serves a top-level `/setup` page — the SELF-HOST first-admin token
   * screen. A hash route inside `/mailbox` would not technically collide with it, and would read
   * as the same thing in every conversation and every link. Two different ceremonies may not
   * share a word.
   */
  firstRun: boolean;
  /**
   * IS THIS A RE-RUN — `#/first-run/again`, from Settings → Mailboxes.
   *
   * It exists because {@link firstRun} alone cannot express it. The flow's opening screen is
   * DERIVED from truth-conditions, and the first of those is the completion stamp: an account
   * that has been through setup derives to "nothing to do", which is exactly right for a boot
   * and exactly wrong for somebody who just pressed "Run setup again". The alternative — clearing
   * the stamp — would be an un-complete instruction, and there deliberately is none: nothing in
   * this product un-finishes onboarding, because a control that silently reopens setup on every
   * future boot is worse than a route segment.
   *
   * So the INTENT rides the URL. A re-run opens on the consent statement and walks forward from
   * there, pre-filled from what the account already stored, and re-stamps completion when it is
   * left — the same ending as a first run.
   */
  firstRunRerun: boolean;
}

export function parseHash(hash: string): Route {
  const rawWithTail = hash.replace(/^#\/?/, "");
  // The open-message tail comes off FIRST, so every branch below reads the same place-path it
  // always did. Whether the view may CARRY the id is decided at the end — a tail on a
  // message-less view (settings, compose, drafts, the Screener's sender rows) drops, and
  // `normalizedHash` rewrites the bar to match.
  const { path: raw, messageId } = splitMessageTail(rawWithTail);
  const withMsg = (route: Route): Route =>
    messageId !== null && MESSAGE_VIEWS.includes(route.view) ? { ...route, messageId } : route;
  if (raw.startsWith("tag/") && raw.slice(4)) {
    return withMsg({ view: "tag", tagId: raw.slice(4), folderId: null, screenerSegment: "waiting", triagePile: "reply", settingsPane: null, messageId: null, firstRun: false, firstRunRerun: false });
  }
  // `#/folder/<entityId>` — one of the mailbox's own folders (FOLDERS-SPEC.md §3, the rail).
  // The tag branch's shape exactly: an id the mirror does not hold falls back in the shell.
  if (raw.startsWith("folder/") && raw.slice(7)) {
    return withMsg({ view: "folder", tagId: null, folderId: raw.slice(7), screenerSegment: "waiting", triagePile: "reply", settingsPane: null, messageId: null, firstRun: false, firstRunRerun: false });
  }
  if (raw === "screener" || raw.startsWith("screener/")) {
    const sub = raw.split("/")[1];
    return {
      view: "screener",
      tagId: null,
      folderId: null,
      screenerSegment: sub === "screened" || sub === "spam" ? sub : "waiting",
      triagePile: "reply",
      settingsPane: null,
      messageId: null,
      firstRun: false,
      firstRunRerun: false,
    };
  }
  // `#/triage`, `#/triage/aside`, `#/triage/resurface`. An unknown sub-path falls to the first
  // pile rather than 404ing, exactly as an unknown screener segment falls to `waiting`.
  if (raw === "triage" || raw.startsWith("triage/")) {
    const sub = raw.split("/")[1];
    return withMsg({
      view: "triage",
      tagId: null,
      folderId: null,
      screenerSegment: "waiting",
      triagePile: (TRIAGE_PILES as readonly string[]).includes(sub ?? "")
        ? (sub as TriagePileId)
        : "reply",
      settingsPane: null,
      messageId: null,
      firstRun: false,
      firstRunRerun: false,
    });
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
      folderId: null,
      screenerSegment: "waiting",
      triagePile: "reply",
      settingsPane: (PANE_IDS as readonly string[]).includes(sub ?? "") ? (sub as PaneId) : null,
      messageId: null,
      firstRun: false,
      firstRunRerun: false,
    };
  }
  // `#/first-run` — the setup stage, OVER whatever the shell would otherwise show. The view is
  // the Ohbox because that is where leaving the stage lands, and because a route must name one;
  // the flag is what puts the dialog on top of it. See {@link Route.firstRun}.
  if (raw === "first-run" || raw === "first-run/again") {
    return {
      view: "ohbox", tagId: null, folderId: null, screenerSegment: "waiting",
      triagePile: "reply", settingsPane: null, messageId: null, firstRun: true,
      firstRunRerun: raw === "first-run/again",
    };
  }
  const view = (VIEWS as readonly string[]).includes(raw) ? (raw as ViewId) : "ohbox";
  return withMsg({ view, tagId: null, folderId: null, screenerSegment: "waiting", triagePile: "reply", settingsPane: null, messageId: null, firstRun: false, firstRunRerun: false });
}

/**
 * The canonical hash for a route — `parseHash`'s inverse, spelled the way the `go*` helpers
 * spell it (`#/triage` for the first pile, `#/screener` for waiting), so a rewrite can never
 * mint a form navigation itself would not produce.
 */
export function canonicalHash(route: Route): string {
  // FIRST, and before the tail: the stage's hash names no view and carries no open message, so
  // every branch below would spell it as something else and `normalizedHash` would then rewrite
  // `#/first-run` to `#/ohbox` on the first render — closing the flow by correcting the bar.
  if (route.firstRun) return route.firstRunRerun ? "#/first-run/again" : "#/first-run";
  // The open-message tail rides any place-path whose view can show one — `parseHash` already
  // refused it everywhere else, so the guard here is for routes built by hand.
  const tail =
    route.messageId !== null && MESSAGE_VIEWS.includes(route.view) ? `/m/${route.messageId}` : "";
  if (route.view === "tag") return `#/tag/${route.tagId}${tail}`;
  if (route.view === "folder") return `#/folder/${route.folderId}${tail}`;
  if (route.view === "screener")
    return route.screenerSegment === "waiting" ? "#/screener" : `#/screener/${route.screenerSegment}`;
  if (route.view === "triage")
    return (route.triagePile === "reply" ? "#/triage" : `#/triage/${route.triagePile}`) + tail;
  // BOTH spellings are canonical for settings: bare (`settingsPane: null` — the pane is the
  // view's deep-link logic's to decide) and named. Only an UNKNOWN sub-path normalizes, to bare.
  if (route.view === "settings")
    return route.settingsPane === null ? "#/settings" : `#/settings/${route.settingsPane}`;
  return `#/${route.view}${tail}`;
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

export function go(view: Exclude<ViewId, "tag" | "folder">): void {
  window.location.hash = `#/${view}`;
}

/**
 * OPEN THE FIRST-RUN STAGE. A hash ASSIGNMENT, so it stacks in history: Back walks out of setup
 * the way it walks out of a reading, which is what a person who opened it from Settings expects.
 */
export function goFirstRun(opts: { rerun?: boolean } = {}): void {
  window.location.hash = opts.rerun ? "#/first-run/again" : "#/first-run";
}

export function goTag(tagId: string): void {
  window.location.hash = `#/tag/${tagId}`;
}

export function goFolder(folderId: string): void {
  window.location.hash = `#/folder/${folderId}`;
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

/**
 * MIRROR THE OPEN MESSAGE INTO THE BAR — the shell's one writer for the `m/<id>` tail.
 *
 * Two verbs on purpose, because history is the product surface here:
 *   · OPENING a message PUSHES (`location.hash` assignment), so Back walks out of the reading
 *     and Forward walks back into it — the reader's actual history;
 *   · MOVING between messages, and CLOSING, REPLACE — a `j`-walk down a pile must not bury the
 *     view under fifty entries, and Back from a closed reading returns to before the reading
 *     rather than to the reading it just closed.
 *
 * `replaceState` fires no `hashchange`, so the replace arm also notifies the route store the
 * way `useHashRoute`'s normalize pass does not need to: the rendered state ALREADY matches (the
 * shell only mirrors what is on screen), so nothing re-renders from it; the event is for the
 * store's own snapshot.
 */
export function reflectMessage(route: Route, messageId: string | null): void {
  const next = canonicalHash({ ...route, messageId });
  if (`#${window.location.hash.replace(/^#/, "")}` === next) return;
  if (messageId !== null && route.messageId === null) {
    window.location.hash = next; // an OPEN pushes
    return;
  }
  window.history.replaceState(window.history.state, "", next);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
