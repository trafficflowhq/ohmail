/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { mirrorDbName } from "@ohmail/client-engine";
import messages from "../messages/en.json";
// TYPE-ONLY: the module itself is imported lazily below (see `Engine`), so the namespace
// does not exist in type position — the resolver contract is named directly instead.
import type { OwnerOutcome, OwnerResolver } from "../app/shell/engine";

/**
 * ═══ THE MAILBOX PAINTS BEFORE THE SESSION CHECK ANSWERS — WITHOUT SKIPPING IT ═════════════
 *
 * The shell used to render NOTHING until `GET /auth/session` came back, because the account id
 * in that answer is what NAMES the persistent mirror and a mis-named mirror is how one person's
 * mail rendered to another. Correct, and it put a network round trip in front of every first
 * paint, ahead of mail that was already on the device.
 *
 * The API now sets the account id in a readable cookie beside the session. The shell reads it
 * synchronously in its first-render initializer, opens that mirror, and paints — while the SAME
 * session check runs in parallel and decides whether to keep the tab.
 *
 * ── WHAT THIS FILE HAS TO PROVE, AND WHY EACH HALF IS NEEDED ────────────────────────────────
 *
 *  1. the warm open HAPPENS (there is a mailbox in the first committed render);
 *  2. the check is not weakened — a mismatch and a refusal each end the tab;
 *  3. confirming does not RE-MOUNT (a warm open that flickers is worse than a slow one);
 *  4. the shared-browser hazard: signing out takes the remembered name and the mail it names in
 *     one act, so nothing is left for the next person to paint from.
 *
 * (4) is the one this seam could get wrong quietly. A cookie left behind after a wipe points
 * the next load at a name whose database is gone; a wipe without the cookie leaves the name
 * pointing at mail. Only both together are the property.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

// Repo-root relative, not `import.meta.url`: under jsdom that is an http URL and
// `fileURLToPath` refuses it. The suite runs from the repo root.
const read = (p: string): string => readFileSync(`${process.cwd()}/${p}`, "utf8");

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";

/** `POST /auth/logout` is the only thing `signOut` needs from the Cloud client. */
const mockLogout = vi.fn(async () => {});
/*
 * ONLY `auth` IS REPLACED — the rest of the client is the real one, and that is a repair.
 *
 * This was a whole-module stub listing each export by hand, and it stubbed the storage-owner binding
 * calls to no-ops. Twice that meant a newly imported name was missing and the sign-out threw
 * before it reached the mirror wipe, failing with "the mail was not deleted" and pointing at the
 * wrong file. Worse, it made the binding UNOBSERVABLE: `sign-out.ts` chooses between returning
 * the client to public and BLOCKING it, and a no-op stub cannot tell those apart — the case that
 * would have caught the refused-logout hole was green against a stub of the thing under test.
 */
vi.mock("../app/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/api-client")>()),
  auth: { logout: mockLogout, armLogoutOnLeave: () => undefined },
}));

type EngineModule = typeof import("../app/shell/engine");
type CookieModule = typeof import("../app/shell/owner-cookie");
type SignOutModule = typeof import("../app/sign-out");

let Engine: EngineModule;
let Cookie: CookieModule;
let SignOut: SignOutModule;

beforeAll(async () => {
  // `engine-config.ts` reads the API base ONCE, at module load, because Next inlines it at build
  // time. So it has to be armed before the first import rather than per test — an unarmed live
  // build throws by design, and that throw is not what any of this is about.
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  Engine = await import("../app/shell/engine");
  Cookie = await import("../app/shell/owner-cookie");
  SignOut = await import("../app/sign-out");
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const originalFetch = globalThis.fetch;

/** Every account id `useEngine()` has been seen holding, in render order. */
let seenEngines: unknown[];

function Probe(): React.ReactElement {
  const engine = Engine.useEngine();
  seenEngines.push(engine);
  return h("div", { "data-testid": "mailbox" }, "mailbox");
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

/** Every account the shell COMMITTED to, in order — see `onConfirmed`. */
let confirmedOwners: string[] = [];

async function mount(resolveOwner?: OwnerResolver): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        children: h(
          Engine.EngineProvider,
          {
            demo: false,
            ...(resolveOwner ? { resolveOwner } : {}),
            onConfirmed: (id: string) => { confirmedOwners.push(id); },
            children: h(Probe),
          },
        ),
      }),
    );
  });
  return host;
}

/** The mailbox is on screen. `null` while the shell is on a session surface instead. */
/** How many `/sync` requests have left the browser since the last mount. */
let syncUrls = 0;
const mailbox = (el: HTMLElement): Element | null => el.querySelector('[data-testid="mailbox"]');

/**
 * A session check the test decides the timing of.
 *
 * Needed for every assertion about the WARM FRAME — the moment the mailbox is on screen and the
 * server has not answered. A resolver that resolves immediately settles inside the same `act` as
 * the mount, so the frame exists and is never observable, and a test written against it would
 * report "the warm open did not happen" whether or not it did.
 */
function deferredOwner(): { resolve: (v: OwnerOutcome) => void; fn: OwnerResolver } {
  let resolve!: (v: OwnerOutcome) => void;
  const promise = new Promise<OwnerOutcome>((r) => { resolve = r; });
  return { resolve, fn: () => promise };
}

/**
 * A factory that RECORDS what it was asked to delete, and nothing else.
 *
 * `clearAllMirrors` enumerates where it can and then asks the browser to delete each database.
 * The act under test is the ASK — that signing out reaches for this account's mirror by name —
 * and a recorder proves it exactly, without this workspace taking on an IndexedDB
 * implementation it has no other use for. The wipe's own correctness (that a deleted mirror
 * really is empty afterwards) belongs to the store's package and is asserted there.
 */
function recordingFactory(deleted: string[]): IDBFactory {
  return {
    databases: async () => [],
    deleteDatabase: (name: string) => {
      deleted.push(name);
      const req = { onsuccess: null } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => (req.onsuccess as unknown as (() => void) | null)?.());
      return req;
    },
  } as unknown as IDBFactory;
}

beforeEach(() => {
  confirmedOwners = [];
  seenEngines = [];
  mockLogout.mockClear();
  // jsdom has no IndexedDB, so `createEngine` builds an in-memory mirror. That is the right
  // default for every test here except the wipe, which installs a recorder for its own duration.
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
  document.cookie = `${Cookie.OWNER_COOKIE}=; Path=/; Max-Age=0`;
  syncUrls = 0;
  // Every drain answers "nothing new". The wire is not the subject here; what paints is —
  // except for the two gate cases below, which count what LEAVES for `/sync`, because the
  // mirror is named for the remembered account and a page that lands before the server has
  // agreed whose mailbox this is lands in the wrong one.
  globalThis.fetch = (async (input?: unknown) => {
    if (String(input).includes("/sync")) syncUrls += 1;
    return new Response(
      JSON.stringify({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: "AQ",
        hasMore: false,
        serverTime: new Date().toISOString(),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => { r.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
});

describe("a remembered account opens its mailbox in the first render", () => {
  it("THE REGRESSION: with the cookie set, the mailbox is on screen before the check answers", async () => {
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    // A resolver that NEVER settles. Anything on screen after this is on screen because of the
    // cookie and the local mirror, and not because the server said so.
    const el = await mount(() => new Promise<OwnerOutcome>(() => {}));
    expect(mailbox(el), "the shell waited for the session check before rendering anything").not.toBeNull();
  });

  it("…and without the cookie it still waits, which is the honest state for a cold browser", async () => {
    const el = await mount(() => new Promise<OwnerOutcome>(() => {}));
    expect(mailbox(el)).toBeNull();
  });

  it("a cold browser still opens once the check answers", async () => {
    const el = await mount(async () => ({ kind: "owner", accountId: ACCOUNT_A }));
    await settle();
    expect(mailbox(el)).not.toBeNull();
  });

  it("NO RESOLVER, NO WARM OPEN — a client that cannot confirm does not get to be optimistic", async () => {
    // The standalone desktop client passes no resolver and has no such cookie. Even given one,
    // it must not open a mailbox on a cookie alone: the confirmation is what makes the optimism
    // safe, so a client with no way to ask stays exactly where it was.
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    const el = await mount();
    await settle();
    expect(mailbox(el)).toBeNull();
    expect(el.textContent).toContain(messages.session.endedTitle);
  });
});

describe("the check is not weakened by one step", () => {
  it("A MISMATCH ENDS THE TAB: cookie says one account, the server says another", async () => {
    // The shared-browser shape. "A session was confirmed" is not the question; whether it is THIS
    // one is. A tab in that state is painting rows that belong to neither the live session nor
    // the person looking at them.
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    const check = deferredOwner();
    const el = await mount(check.fn);
    expect(mailbox(el), "the warm open did not happen, so this proves nothing").not.toBeNull();
    check.resolve({ kind: "owner", accountId: ACCOUNT_B });
    await settle();
    expect(mailbox(el), "a mismatched session kept the mailbox on screen").toBeNull();
    expect(el.textContent).toContain(messages.session.endedTitle);
  });

  it("A REFUSAL ENDS THE TAB: the server will not confirm a full session", async () => {
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    const check = deferredOwner();
    const el = await mount(check.fn);
    expect(mailbox(el), "the warm open did not happen, so this proves nothing").not.toBeNull();
    check.resolve({ kind: "none" });
    await settle();
    expect(mailbox(el)).toBeNull();
  });

  /**
   * ── THIS TEST USED TO ASSERT THE OPPOSITE, AND ITS OWN TITLE CARRIED THE MISTAKE ─────────
   *
   * It read "A FAILED CHECK ENDS THE TAB TOO — an unreachable server is not a confirmation",
   * and the premise is right while the conclusion inverts it. "Not a confirmation" is a
   * reason to KEEP ASKING, never a reason to declare the answer. Ending the tab on it is a
   * confirmation — of the harshest available outcome — drawn from no evidence at all.
   *
   * What it cost: a `503 db_busy` on the confirm rendered "You are signed out." over a live
   * cookie, measured in production three seconds before it was reported
   * (the project's design notes), and the warm mirror was torn down with it —
   * which is why the screenshot is a bare card with no mail behind it.
   *
   * The claim it was reaching for survives intact and is directly below: an ANSWERED refusal
   * still ends the tab, on the first ask. The difference is who said so.
   */
  it("AN UNREACHABLE SERVER DOES NOT END THE TAB — nothing was learned, so nothing is claimed", async () => {
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    const el = await mount(async () => ({ kind: "unknown", retryAfterMs: null }));
    await settle();
    expect(mailbox(el), "a server that could not answer tore the mailbox down").not.toBeNull();
    expect(el.textContent, "an unanswered check was rendered as a sign-out")
      .not.toContain(messages.session.endedBody);
  });

  it("A RESOLVER THAT THROWS reports the failure instead of accusing the session", async () => {
    // `resolveOwner` answers rather than rejects, so a throw here is something that blew
    // up on OUR side of the answer — `createEngine` refused, storage is unavailable. None of
    // that is evidence about the session, and this branch used to say it was.
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    const el = await mount(async () => { throw new Error("network down"); });
    await settle();
    expect(el.textContent, "a thrown resolver was rendered as a sign-out")
      .not.toContain(messages.session.endedBody);
    expect(el.textContent, "the failure was not reported at all")
      .toContain(messages.session.unconfirmedTitle);
    expect(mailbox(el), "the mail this device holds was thrown away on a local failure")
      .not.toBeNull();
  });

  /**
   * ── AND A MISMATCH NEVER LETS A PAGE LAND ────────────────────────────────────────────────
   *
   * The session check ends the tab when the server names a different account, but it does so AFTER the answer
   * arrives — and the warm engine has been scheduled since the render after hydration. Its
   * mirror is named for the remembered account and `/sync` carries no identity, so every page
   * landing before the comparison lands in the wrong mailbox. The gate makes that window zero
   * rather than "however long the confirm takes".
   */
  it("A MISMATCH never lets a page land", async () => {
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    const check = deferredOwner();
    const el = await mount(check.fn);
    expect(mailbox(el), "the warm open did not happen, so this proves nothing").not.toBeNull();
    await settle();
    expect(syncUrls, "a page landed before the server named the account").toBe(0);

    check.resolve({ kind: "owner", accountId: ACCOUNT_B });
    await settle();
    expect(syncUrls, "a page landed under the other account's session").toBe(0);
    expect(mailbox(el), "a mismatched session kept the mailbox on screen").toBeNull();
  });

  it("A MATCH opens the gate", async () => {
    // The control: without it, the case above passes with the gate welded shut.
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    const check = deferredOwner();
    const el = await mount(check.fn);
    await settle();
    expect(syncUrls, "the gate leaked before the confirm").toBe(0);
    check.resolve({ kind: "owner", accountId: ACCOUNT_A });
    await settle();
    expect(syncUrls, "the gate never opened for the account it belongs to")
      .toBeGreaterThanOrEqual(1);
    expect(mailbox(el)).not.toBeNull();
  });

  /**
   * ═══ THE CLIENT IS BOUND BY THE ARM THAT BELIEVED THE ANSWER, NOT BY THE CLASSIFIER ══════
   *
   * `resolveOwnerOutcome` used to call `bindApiOwner` on its way past — one place learns the id,
   * so one place records it. It mutates SHARED state that in-flight requests are judged against,
   * and it does so before this tab has decided whether the answer is even about its mirror.
   *
   * The sequence: a warm request for A leaves while the client is `pending(A)`; another tab signs
   * in as B; the classifier answers B and rebinds to B on the spot; the in-flight A request's
   * recovery path re-reads the binding, sees B, judges itself to hold, and refreshes and retries
   * under B. A resolver whose effect had already been CANCELLED did it too, because a cancelled
   * promise still runs its `.then`.
   *
   * So the commitment moved to the arm. Pinned in both directions, because only the pair is
   * the property: a MATCH binds, a MISMATCH binds nothing at all.
   */
  it("an account MISMATCH commits no binding, and a match commits exactly one", async () => {
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    await mount(async () => ({ kind: "owner", accountId: ACCOUNT_B }));
    await settle();
    expect(confirmedOwners, "a mismatch bound the client to the account it just refused")
      .toEqual([]);

    confirmedOwners = [];
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    await mount(async () => ({ kind: "owner", accountId: ACCOUNT_A }));
    await settle();
    expect(confirmedOwners, "the match never committed, so nothing is bound at all")
      .toEqual([ACCOUNT_A]);
  });

  it("A MATCH KEEPS THE VERY SAME ENGINE — confirming must not re-mount the mailbox", async () => {
    // A second `createEngine` for the same account would re-open the database, hydrate it again
    // and restart the drain: a visible re-mount of the whole shell as a reward for being right.
    // The scheduler effect keys on the engine object, so identity is the property, not equality.
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    const el = await mount(async () => ({ kind: "owner", accountId: ACCOUNT_A }));
    await settle();
    expect(mailbox(el)).not.toBeNull();
    expect(seenEngines.length).toBeGreaterThan(1);
    expect(new Set(seenEngines).size, "the engine was replaced when the check came back").toBe(1);
  });
});

describe("the shared-browser hazard: signing out takes the name and the mail together", () => {
  it("THE PAIRING: sign-out clears the remembered account AND wipes its mirror", async () => {
    const deleted: string[] = [];
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = recordingFactory(deleted);
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    expect(Cookie.readOwner()).toBe(ACCOUNT_A);

    await SignOut.signOut(ACCOUNT_A);

    expect(mockLogout, "the server was never told").toHaveBeenCalledTimes(1);
    expect(Cookie.readOwner(), "the next load would still open this account's mirror").toBeNull();
    expect(deleted, "this account's mail is still on this machine").toContain(mirrorDbName(ACCOUNT_A));
  });

  it("…even when the server could not be reached — the browser is cleared either way", async () => {
    // The case that matters. A person on a borrowed machine asking to be signed out is asking
    // whether or not the network answers, and a `then` here instead of a `finally` would leave
    // both the name and the mail behind on exactly the machine they were worried about.
    const deleted: string[] = [];
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = recordingFactory(deleted);
    mockLogout.mockRejectedValueOnce(new Error("network down"));
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    await SignOut.signOut(ACCOUNT_A).catch(() => {});
    expect(Cookie.readOwner()).toBeNull();
    expect(deleted).toContain(mirrorDbName(ACCOUNT_A));

    /*
     * ── AND THE MARKER SAYS SO RATHER THAN GOING SILENT ───────────────────────────────────
     *
     * The local half runs either way and that is still right. Erasing the MARKER as part of it
     * was not, and only on this path. The server may still hold this session — that is what a
     * failed logout means — and clearing the one readable thing that says whose session the
     * browser holds left another account's window reading absence as silence, silence as
     * permission, and syncing, reading and mutating through the session this sign-out had just
     * failed to revoke.
     *
     * So the marker is WRITTEN, not erased. `readOwner()` above still answers `null`, because
     * this is not an account id and nothing may name a mirror or a storage key with it; the
     * sync gate reads the fuller answer and refuses.
     */
    expect(Cookie.readOwnerMarker().kind, "a refused sign-out left the browser saying nothing")
      .toBe("signed-out");

    /*
     * ── AND THE CLOUD CLIENT IS BLOCKED, NOT UNBOUND ─────────────────────────────────────
     *
     * The marker exists so another window stops trusting a session the server would not revoke.
     * Sign-out then unbound the API client one line later, which turned the account-owner boundary off
     * for every settings pane mounted afterwards — the remedy waving through the sequence it was
     * written for. A settings pane opening now must refuse.
     */
    const client = await import("../app/api-client");
    expect(client.apiOwnerBinding().kind, "a refused sign-out unbound the client instead of blocking it")
      .toBe("blocked");
    expect(client.apiOwnerHolds("/auth/2fa/recovery-codes"),
      "another account's credentials were reachable after a refused sign-out").toBe(false);
    expect(client.apiOwnerHolds("/mailboxes")).toBe(false);
    // The way out stays open, or the person cannot recover from this state.
    expect(client.apiOwnerHolds("/auth/login"), "the front door was locked too").toBe(true);
    expect(client.apiOwnerHolds("/auth/logout"), "the logout could not be retried").toBe(true);
    expect(client.apiOwnerHolds("/auth/refresh/logout"), "the sign-out door could not be retried").toBe(true);
    const { createSyncGate } = await import("../app/shell/sync-scheduler.js");
    const gate = createSyncGate(ACCOUNT_A);
    gate.confirm(ACCOUNT_A);
    expect(gate.identity(), "a mirror stayed open through a session the sign-out could not revoke")
      .toBe("contradicted");
  });

  /**
   * THE OTHER HALF OF THE SAME PATH: a sign-out the server CONFIRMED erases the marker exactly as
   * it always did. Absence is silence, and after a confirmed sign-out silence is the truth —
   * there is no session left to be wrong about. Without this case the fix above would be
   * satisfied by writing the marker unconditionally, which would leave a browser claiming a
   * pending sign-out for ever after a perfectly ordinary one.
   */
  it("a sign-out the server CONFIRMED erases the marker, as before", async () => {
    const deleted: string[] = [];
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = recordingFactory(deleted);
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    await SignOut.signOut(ACCOUNT_A);
    expect(Cookie.readOwnerMarker().kind, "an ordinary sign-out left a pending claim behind")
      .toBe("absent");
    // …and the client returns to public: there is no session left to be wrong about, and a
    // binding left standing would refuse the reads the sign-in that follows has to make.
    const client = await import("../app/api-client");
    expect(client.apiOwnerBinding().kind, "a confirmed sign-out left the client bound or blocked")
      .toBe("public");
    expect(deleted).toContain(mirrorDbName(ACCOUNT_A));
  });

  it("THE CONSEQUENCE: the next person's tab has nothing to paint from", async () => {
    // The chain end to end. After a sign-out there is no remembered name, so the shell takes the
    // cold path and asks first — which is what stops a second account inheriting the first one's
    // rendered mailbox for the few hundred milliseconds before the check lands.
    document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
    await SignOut.signOut(ACCOUNT_A);
    const el = await mount(() => new Promise<OwnerOutcome>(() => {}));
    expect(mailbox(el)).toBeNull();
  });
});

describe("the cookie itself", () => {
  it("a malformed value is treated as ABSENT, never repaired", () => {
    // It is about to name a database and be compared against a server-issued id. A value that
    // cannot do either is not something to guess at.
    expect(Cookie.readOwner("tf_owner=has spaces")).toBeNull();
    expect(Cookie.readOwner("tf_owner=")).toBeNull();
    expect(Cookie.readOwner("tf_session=abc")).toBeNull();
    expect(Cookie.readOwner("")).toBeNull();
  });

  it("it is found beside the other cookies, not only alone", () => {
    expect(Cookie.readOwner(`tf_csrf=xyz; ${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; tf_resume=1`)).toBe(ACCOUNT_A);
  });

  it("the client and the API agree on the NAME — two files, one string", () => {
    // The shell cannot import the API package (it ships in a client that has no server at all),
    // so the name is written twice. A rename on one side would not fail to compile; it would
    // silently turn every warm open back into a blocking one.
    const api = read("packages/api/src/cookies.ts");
    const shell = read("apps/webapp/app/shell/owner-cookie.ts");
    const apiName = /export const OWNER_COOKIE = "([^"]+)"/.exec(api)?.[1];
    const shellName = /export const OWNER_COOKIE = "([^"]+)"/.exec(shell)?.[1];
    expect(apiName, "the API no longer exports OWNER_COOKIE — re-aim this").toBeTruthy();
    expect(shellName).toBe(apiName);
  });
});

/**
 * ═══ AND THE FIRST RENDER OF ALL IS STILL THE SERVER'S ═════════════════════════════════════
 *
 * The warm open reads a cookie, and the server that rendered the page could not. For a while
 * that read happened in the FIRST client render — which on a real page load is the hydration
 * render — so a browser with a remembered account produced the whole mail client where the
 * server had produced the near-empty session gate. React compares the two, reports a mismatch at
 * every level of the tree, and then throws the server's markup away and re-renders the root from
 * scratch: eight mismatch reports and one recovery per signed-in load, all of it on the exact
 * load the warm open exists to make fast.
 *
 * The decision now happens one render later, behind a layout-effect flip — same frame, no extra
 * paint, and a hydration render that says what the server said.
 *
 * ── WHAT MAKES THIS TEST HONEST ────────────────────────────────────────────────────────────
 *
 * jsdom has one `document`, so a naive version would hand the "server" render the same cookie
 * the browser has and the two would agree for the wrong reason. So the markup is rendered with
 * the cookie ABSENT — which is the server's real situation — and the cookie is set immediately
 * afterwards, before hydration. That is the production sequence, and it is what makes the old
 * shape fail here: reading the cookie in the initializer would build a mailbox against a gate.
 */
/**
 * `renderToString` under jsdom warns that `useLayoutEffect` does nothing on the server, and it is
 * an artifact of the harness rather than a fact about the app: the provider picks its effect from
 * `typeof window`, which is undefined in the Node process that renders a real page and defined
 * here, where one `document` plays both parts. It is captured with everything else so the
 * assertions can say what they mean — no hydration report, and nothing else unexplained.
 */
const SSR_LAYOUT_EFFECT_NOTE = /useLayoutEffect does nothing on the server/;

/** Run `body` with `console.error` collected rather than printed. */
async function quiet(body: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await body();
  } finally {
    console.error = real;
  }
  return lines;
}

describe("hydration", () => {
  it("hydrates the server's own markup, then opens warm — no mismatch, no recovery", async () => {
    // The server cannot read cookies belonging to the browser.
    document.cookie = `${Cookie.OWNER_COOKIE}=; Path=/; Max-Age=0`;
    const tree = h(NextIntlClientProvider, {
      locale: "en",
      messages,
      children: h(
        Engine.EngineProvider,
        {
          demo: false,
          resolveOwner: async () => ({ kind: "owner", accountId: ACCOUNT_A }) as const,
          children: h(Probe),
        },
      ),
    });

    /* React reports a hydration mismatch two ways: through `onRecoverableError` (which is where
       the "switching to client rendering" recovery arrives) and through `console.error`. Both are
       collected, because a test that watched only one of them would pass on a page that still
       logs eight errors at every signed-in load. */
    const recoverable: unknown[] = [];
    const logged = await quiet(async () => {
      const html = renderToString(tree);
      host = document.createElement("div");
      host.innerHTML = html;
      document.body.appendChild(host);
      // …and now the browser, which does have one.
      document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
      await act(async () => {
        root = hydrateRoot(host!, tree, { onRecoverableError: (err) => { recoverable.push(err); } });
      });
      await settle();
    });

    expect(recoverable.map(String), "React had to recover from the hydration").toEqual([]);
    expect(
      logged.filter((line) => !SSR_LAYOUT_EFFECT_NOTE.test(line)),
      "React reported something about the hydration",
    ).toEqual([]);
    // …and the point of all of it: the mailbox is open by the time the dust settles.
    expect(mailbox(host!), "the warm open stopped happening").not.toBeNull();
  });

  it("asks the session check ONCE across the whole sequence", async () => {
    // The warm decision lands one commit after hydration, so a check that ran on the commit
    // before it would run again against the warm binding — two `GET /auth/session` per load, on
    // every signed-in browser. The gate that prevents it is easy to remove and impossible to see.
    document.cookie = `${Cookie.OWNER_COOKIE}=; Path=/; Max-Age=0`;
    let asked = 0;
    const resolveOwner: OwnerResolver = async () => {
      asked += 1;
      return { kind: "owner", accountId: ACCOUNT_A };
    };
    const tree = h(NextIntlClientProvider, {
      locale: "en",
      messages,
      children: h(Engine.EngineProvider, { demo: false, resolveOwner, children: h(Probe) }),
    });

    await quiet(async () => {
      const html = renderToString(tree);
      host = document.createElement("div");
      host.innerHTML = html;
      document.body.appendChild(host);
      document.cookie = `${Cookie.OWNER_COOKIE}=${ACCOUNT_A}; Path=/`;
      await act(async () => { root = hydrateRoot(host!, tree); });
      await settle();
    });

    expect(asked).toBe(1);
    expect(mailbox(host!)).not.toBeNull();
  });
});
