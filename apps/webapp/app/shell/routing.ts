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
  /**
   * Trash — mail deleted in ohmail, and the one place it can be seen and put back. Reached from the
   * palette or `g t`, not from a permanent rail row: the rail's places are where mail is, and the rail
   * grows a transient entry for exactly as long as this view is the route (`AppShell`'s `railGroups`).
   * Deliberately not one of `PILE_IDS`, so the number keys skip it — History's and Drafts' reason.
   */
  "trash",
  "settings",
] as const;
/**
 * `"tag"`, `"folder"` and `"address"` are parameterized views — one tag, one of the mailbox's own
 * folders, or one correspondent, across the URL as `#/tag/<id>` / `#/folder/<id>` /
 * `#/address/<addr>`. The folder id is the `folder` entity's id (an opaque row id), never the
 * path: a canonical path contains `/`, which would collide with the `m/<messageId>` tail this
 * router splits first.
 *
 * `address` is the one whose parameter is not an id we minted but a string a SENDER chose, so it
 * is the one that is percent-encoded in both directions — see {@link Route.address}.
 */
export type ViewId = (typeof VIEWS)[number] | "tag" | "folder" | "address";
export type ScreenerSegmentId = "waiting" | "screened" | "spam";
/**
 * Which triage pile is open — the thing the route could not say. The rail lists Answer Later, Park and
 * Resurface, and `AppShell` collapsed every id beginning `triage` into `go("triage")`: all three rows
 * navigated to one URL, showed one screen, and lit the first row whichever was clicked — selecting
 * Park was not merely unbound, it was unrepresentable. The ids are the pile's own names, not the
 * rail's (`triage-aside`), because the URL carries them: `#/triage/aside` reads as a place.
 */
export const TRIAGE_PILES = ["reply", "aside", "resurface"] as const;
export type TriagePileId = (typeof TRIAGE_PILES)[number];

/**
 * The settings panes, and why the router owns the list. `#/settings/<pane>` is a route segment, so the
 * router must validate it like a screener segment or a triage pile: an unknown sub-path falls back
 * rather than 404ing, and `normalizedHash` rewrites the bar to the spelling that reproduces the screen.
 * The list lived in `SettingsView`; a copy in each file is two lists one new pane apart from
 * disagreeing, so the view re-exports this one. Which panes exist on a given surface is still the
 * view's per-surface clamp; this list is only "what may a URL say".
 */
export const PANE_IDS = [
  "general", "notifications", "mailboxes", "screener", "ai", "away", "billing", "invites", "tags",
  "rules", "folders", "signatures", "about", "security", "account", "desktop", "devices",
] as const;
export type PaneId = (typeof PANE_IDS)[number];

/**
 * THE VIEWS WHOSE URL MAY NAME AN OPEN MESSAGE — everything that can show one. Settings and
 * Compose have no message to open; Drafts opens a COMPOSE (its rows are the account's own
 * unsent mail), and the Screener's rows are SENDERS, not messages, so a message id says
 * nothing its list can locate. A `m/<id>` tail on any of the excluded views normalizes away.
 */
const MESSAGE_VIEWS: readonly string[] = ["ohbox", "reads", "receipts", "history", "search", "tag", "folder", "triage", "address", "trash"];

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
  /**
   * The correspondent when `view === "address"` — `#/address/<addr>`, decoded; `null` elsewhere.
   * `tagId`'s twin, except an address is a string a stranger put in a header, not an id this product
   * minted, so it is `decodeURIComponent`d in and `encodeURIComponent`d out where the other two are
   * carried raw: a `/` in a quoted local part would become a path boundary, a `#` truncates the
   * fragment, and `%` round-trips wrongly if only one side escapes. The pair is what makes
   * `canonicalHash(parseHash(h)) === h` hold, which stops `normalizedHash` rewriting the bar every
   * render. A malformed escape (`decodeURIComponent` throws on a lone `%`) is not a crash or an Ohbox
   * fallback: the raw segment is used — it matches no mail and the empty state names the address.
   */
  address: string | null;
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
   * Is the first-run stage open — `#/first-run`, the one route field not about which view shows. The
   * stage is a dialog over the app, so it rides beside {@link view}: `#/first-run` parses to the Ohbox
   * with this set, the shell renders both, and leaving the stage changes nothing else on screen. A
   * `ViewId` member would have put setup in the rail, the number keys, and every `go()` call's type.
   * Named `first-run`, not `setup`: `apps/webapp` already serves a top-level `/setup` page (the
   * self-host first-admin token screen), and two different ceremonies may not share a word.
   */
  firstRun: boolean;
  /**
   * Is this a re-run — `#/first-run/again`, from Settings → Mailboxes. {@link firstRun} alone cannot
   * express it: the flow's opening screen is derived from truth-conditions, and the completion stamp
   * derives to "nothing to do" — right for a boot, wrong for somebody who pressed "Run setup again".
   * There is deliberately no way to clear the stamp: nothing un-finishes onboarding, because a control
   * that silently reopens setup on every boot is worse than a route segment. So the intent rides the
   * URL: a re-run opens on the consent statement, pre-filled, and re-stamps completion when left.
   */
  firstRunRerun: boolean;
  /**
   * Is this an "add a mailbox" run — `#/first-run/add`, from Settings → Mailboxes. Like a re-run it
   * cannot be derived (the completion stamp makes `deriveOnboardingStep` answer `null`), and it is not
   * a flag on the re-run: a re-run opens on the consent statement for a mailbox that exists and walks
   * the AI question again; an add opens on the connect form for one that does not exist yet and walks
   * neither AI screen — the model is a property of the install (`ai-provider.ts`). It also carries the
   * connect mode: `FirstRunHost.connect` takes a required `"seed" | "add"` — `seed` reconfigures the
   * install's own door, `add` posts to `POST /local/mailboxes` — and a default would pick the
   * destructive one: a seed connect from the Add screen replaces the engine and reseals the password.
   */
  firstRunAdd: boolean;
  /**
   * Which mailbox this run is about — `?mailbox=<id>`, or `null` when the hash did not say. A
   * standalone install can hold more than one mailbox, so `AppShell` reads this id out of
   * `GET /mailboxes` and falls back to the first row only when the hash names none, or names one the
   * install no longer has — an id the list does not hold falls back in the shell, as {@link messageId}
   * does. `null` and not `""`: the hash either names a mailbox or it does not, and an empty string
   * would be a third state both readers would have to know about.
   */
  firstRunMailboxId: string | null;
}

/**
 * The mailbox a first-run hash names — `?mailbox=<id>`, or `null`. The hash gained a query because a
 * standalone install can hold more than one mailbox and the flow has to say which. Only the first-run
 * branch reads it; every other route ignores what follows the `?`, as it always did. Blank is `null`,
 * not `""`: `#/first-run?mailbox=` names no mailbox, and the caller's fallback is the same as for a
 * hash with no query at all.
 */
function firstRunMailboxOf(query: string): string | null {
  if (query === "") return null;
  const named = (new URLSearchParams(query).get("mailbox") ?? "").trim();
  return named === "" ? null : named;
}

/**
 * ONE HASH SEGMENT AS AN ADDRESS — decoded, and never a throw.
 *
 * `decodeURIComponent` raises `URIError` on a malformed escape (a lone `%`, `%zz`), and this is
 * reached from `parseHash`, which every render calls: an exception here would blank the whole
 * shell for a hand-edited URL or a link a mail client half-escaped. The raw segment is the
 * fallback — it matches no mail, so the view's empty state names it, which is a legible answer
 * to a broken link rather than a white screen.
 */
function decodedAddress(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * THE CANONICAL HASH FOR ONE ADDRESS — {@link decodedAddress}'s inverse, and the ONLY place this
 * product spells that URL.
 *
 * Three callers: {@link canonicalHash} (so the address bar is rewritten to a form navigation
 * itself produces), {@link goAddress} (the navigation), and `address-view.ts`'s `addressHref`
 * (the `href` a control renders, which is what a reader hovers). They must agree byte for byte
 * or `normalizedHash` rewrites the bar under a link that was already correct — so they are one
 * function rather than three that match today.
 */
export function addressHash(address: string): string {
  return `#/address/${encodeURIComponent(address)}`;
}

export function parseHash(hash: string): Route {
  // THE QUERY COMES OFF FIRST, ahead of the open-message tail, so every branch below reads the
  // same place-path it always did. Splitting it after the tail would leave `?mailbox=…` glued to
  // a message id on the one route that can carry both.
  const rawWithQuery = hash.replace(/^#\/?/, "");
  const queryAt = rawWithQuery.indexOf("?");
  const query = queryAt === -1 ? "" : rawWithQuery.slice(queryAt + 1);
  const rawWithTail = queryAt === -1 ? rawWithQuery : rawWithQuery.slice(0, queryAt);
  // The open-message tail comes off FIRST, so every branch below reads the same place-path it
  // always did. Whether the view may CARRY the id is decided at the end — a tail on a
  // message-less view (settings, compose, drafts, the Screener's sender rows) drops, and
  // `normalizedHash` rewrites the bar to match.
  const { path: raw, messageId } = splitMessageTail(rawWithTail);
  const withMsg = (route: Route): Route =>
    messageId !== null && MESSAGE_VIEWS.includes(route.view) ? { ...route, messageId } : route;
  if (raw.startsWith("tag/") && raw.slice(4)) {
    return withMsg({ view: "tag", tagId: raw.slice(4), folderId: null, address: null, screenerSegment: "waiting", triagePile: "reply", settingsPane: null, messageId: null, firstRun: false, firstRunRerun: false, firstRunAdd: false, firstRunMailboxId: null });
  }
  // `#/folder/<entityId>` — one of the mailbox's own folders (FOLDERS-SPEC.md §3, the rail).
  // The tag branch's shape exactly: an id the mirror does not hold falls back in the shell.
  if (raw.startsWith("folder/") && raw.slice(7)) {
    return withMsg({ view: "folder", tagId: null, folderId: raw.slice(7), address: null, screenerSegment: "waiting", triagePile: "reply", settingsPane: null, messageId: null, firstRun: false, firstRunRerun: false, firstRunAdd: false, firstRunMailboxId: null });
  }
  // `#/address/<addr>` — everything from and to one correspondent. The tag branch's shape, with
  // the segment DECODED: see {@link Route.address} for why this one is escaped and the other two
  // are not. An address the mirror has no mail for falls back in the view (its empty state names
  // the address), never 404s here — exactly as an unknown tag or folder id does.
  if (raw.startsWith("address/") && raw.slice(8)) {
    return withMsg({ view: "address", tagId: null, folderId: null, address: decodedAddress(raw.slice(8)), screenerSegment: "waiting", triagePile: "reply", settingsPane: null, messageId: null, firstRun: false, firstRunRerun: false, firstRunAdd: false, firstRunMailboxId: null });
  }
  if (raw === "screener" || raw.startsWith("screener/")) {
    const sub = raw.split("/")[1];
    return {
      view: "screener",
      tagId: null,
      folderId: null, address: null,
      screenerSegment: sub === "screened" || sub === "spam" ? sub : "waiting",
      triagePile: "reply",
      settingsPane: null,
      messageId: null,
      firstRun: false,
      firstRunRerun: false,
      firstRunAdd: false,
      firstRunMailboxId: null,
    };
  }
  // `#/triage`, `#/triage/aside`, `#/triage/resurface`. An unknown sub-path falls to the first
  // pile rather than 404ing, exactly as an unknown screener segment falls to `waiting`.
  if (raw === "triage" || raw.startsWith("triage/")) {
    const sub = raw.split("/")[1];
    return withMsg({
      view: "triage",
      tagId: null,
      folderId: null, address: null,
      screenerSegment: "waiting",
      triagePile: (TRIAGE_PILES as readonly string[]).includes(sub ?? "")
        ? (sub as TriagePileId)
        : "reply",
      settingsPane: null,
      messageId: null,
      firstRun: false,
      firstRunRerun: false,
      firstRunAdd: false,
      firstRunMailboxId: null,
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
      folderId: null, address: null,
      screenerSegment: "waiting",
      triagePile: "reply",
      settingsPane: (PANE_IDS as readonly string[]).includes(sub ?? "") ? (sub as PaneId) : null,
      messageId: null,
      firstRun: false,
      firstRunRerun: false,
      firstRunAdd: false,
      firstRunMailboxId: null,
    };
  }
  // `#/first-run` — the setup stage, OVER whatever the shell would otherwise show. The view is
  // the Ohbox because that is where leaving the stage lands, and because a route must name one;
  // the flag is what puts the dialog on top of it. See {@link Route.firstRun}.
  if (raw === "first-run" || raw === "first-run/again" || raw === "first-run/add") {
    return {
      view: "ohbox", tagId: null, folderId: null, address: null, screenerSegment: "waiting",
      triagePile: "reply", settingsPane: null, messageId: null, firstRun: true,
      firstRunRerun: raw === "first-run/again",
      firstRunAdd: raw === "first-run/add",
      // The one route that reads the query. See {@link Route.firstRunMailboxId}.
      firstRunMailboxId: firstRunMailboxOf(query),
    };
  }
  const view = (VIEWS as readonly string[]).includes(raw) ? (raw as ViewId) : "ohbox";
  return withMsg({ view, tagId: null, folderId: null, address: null, screenerSegment: "waiting", triagePile: "reply", settingsPane: null, messageId: null, firstRun: false, firstRunRerun: false, firstRunAdd: false, firstRunMailboxId: null });
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
  if (route.firstRun) {
    const base = route.firstRunRerun
      ? "#/first-run/again"
      : route.firstRunAdd ? "#/first-run/add" : "#/first-run";
    // THE NAMED MAILBOX IS PART OF THE CANONICAL FORM. Without it `normalizedHash` would rewrite
    // `#/first-run?mailbox=<id>` to the bare hash on the first render — dropping, in the address
    // bar, the one fact that says which mailbox the flow in front of somebody is about.
    return route.firstRunMailboxId === null
      ? base
      : `${base}?mailbox=${encodeURIComponent(route.firstRunMailboxId)}`;
  }
  // The open-message tail rides any place-path whose view can show one — `parseHash` already
  // refused it everywhere else, so the guard here is for routes built by hand.
  const tail =
    route.messageId !== null && MESSAGE_VIEWS.includes(route.view) ? `/m/${route.messageId}` : "";
  if (route.view === "tag") return `#/tag/${route.tagId}${tail}`;
  if (route.view === "folder") return `#/folder/${route.folderId}${tail}`;
  // ENCODED, matching `decodedAddress` on the way in. The pair is what makes
  // `canonicalHash(parseHash(h)) === h` hold for an address whose local part carries a `/`, a
  // `#` or a `%` — without it `normalizedHash` would rewrite the address bar on every render of
  // a perfectly good URL, and the rewrite would truncate the address it was correcting.
  if (route.view === "address") return `${addressHash(route.address ?? "")}${tail}`;
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
export function goFirstRun(
  opts: { rerun?: boolean; add?: boolean; mailboxId?: string } = {},
): void {
  const base = opts.rerun
    ? "#/first-run/again"
    : opts.add ? "#/first-run/add" : "#/first-run";
  window.location.hash = opts.mailboxId
    ? `${base}?mailbox=${encodeURIComponent(opts.mailboxId)}`
    : base;
}

/**
 * NAME THE MAILBOX AN ADD RUN JUST MADE, WITHOUT ADDING A HISTORY ENTRY.
 *
 * `replaceState` rather than a hash assignment, and the difference is the Back press. The create
 * is not a place somebody navigated to; it is a thing that happened on the screen they are on. An
 * assignment would stack an entry, and Back would then land on `#/first-run/add` with no mailbox
 * named — which renders the connect FORM again, for a mailbox that now exists.
 *
 * `replaceState` fires no `hashchange`, so the event is dispatched by hand: `useHashRoute`
 * subscribes to exactly that event and would otherwise keep rendering the old route until
 * something else moved the hash. A plain `Event` and not a `HashChangeEvent` — the listener reads
 * `window.location.hash` rather than the event's fields, and the narrower constructor is the one
 * every environment this bundle runs in has.
 */
export function nameFirstRunMailbox(mailboxId: string): void {
  const next = `#/first-run/add?mailbox=${encodeURIComponent(mailboxId)}`;
  if (window.location.hash === next) return;
  window.history.replaceState(window.history.state, "", next);
  window.dispatchEvent(new Event("hashchange"));
}

export function goTag(tagId: string): void {
  window.location.hash = `#/tag/${tagId}`;
}

export function goFolder(folderId: string): void {
  window.location.hash = `#/folder/${folderId}`;
}

/**
 * OPEN THE ADDRESS VIEW. A hash ASSIGNMENT, so it stacks in history: Back walks out of one
 * person's mail and returns to the list the address was clicked in, which is what somebody who
 * followed a name expects.
 *
 * The spelling comes from {@link addressHash}, which `canonicalHash` and `address-view.ts`'s
 * `addressHref` also use, so the link a control renders and the hash this writes cannot differ.
 */
export function goAddress(address: string): void {
  window.location.hash = addressHash(address);
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
