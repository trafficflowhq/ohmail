/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerConsentWith, answerStoreWith, answerSyncWith, installShellEnv, mailbox, mountShell,
  teardownShellEnv, textOf, tick,
} from "./fixtures/live-walk-shell";
import en from "../messages/en.json";

/**
 * ═══ A REACH-PAST ROW'S BODY IS MAIL, NOT A PERMANENT APOLOGY ══════════════════════════════
 *
 * The folder view lists mail from beyond the mirror window through `useOlderMail` — rows that
 * are deliberately not mirror rows. The engine's body machinery keys on the mirror, so opening
 * one of those rows never issued a request at all: the pane's stall face said "Couldn't load
 * the full message — showing the preview" over a fetch that had never started, and its Retry
 * re-ran the same no-op. Measured live on every folder message below the
 * bootstrap window.
 *
 * The fix is the session body door (`shell/older-body.ts`, the junk window's pattern pointed
 * at `GET /messages/:id/body`), spliced in at the one seam every pane reads
 * (`AppShell`'s `bodyOf`/`hydrateBody`). What is proven here, against the SHIPPED shell:
 *
 *  1. opening a reach-past row fetches its stored body and renders it in full;
 *  2. a body the server withholds by policy renders the honest withheld sentence, with no
 *     Retry — a retry cannot change a policy;
 *  3. a row the account no longer holds (404) renders the expunged sentence, with no Retry —
 *     never a control whose promise cannot be kept;
 *  4. a transport failure renders the failed face WITH a Retry, and the Retry now actually
 *     works: pressing it fetches again and the body appears.
 *
 * The reach-past LIST ask itself is also pinned to carry the folder's whole address — the
 * sidecar half of the same defect died on a handler that dropped `folderId`.
 */

const FOLDER_ID = "fd_receipts";
const PAST_ID = "m_past_1";
/** Comfortably before the fixture clock's 60-day window. */
const OLD = "2024-03-02T09:00:00.000Z";
const BODY_TEXT = "the full stored body of the reach-past row, delivered through the door";

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const folderEntity = (seq: number) => ({
  type: "folder", op: "create", id: FOLDER_ID, seq, updatedAt: ISO,
  entity: { id: FOLDER_ID, name: "Receipts", mailboxId: "mb_1", mailbox: "walker@example.invalid", updatedAt: ISO },
});

/**
 * Which id the LIST route hands back. `PAST_ID` for every ordinary case; a test that flips the
 * cookie mid-session moves it, because a foreign session answers the list with foreign ids and
 * because the door's session cache would otherwise answer a repeat open from memory.
 */
let listId = PAST_ID;
/** The mailbox the reach-past row was delivered to. */
let listMailbox = "mb_1";
const FOREIGN_TEXT = "the other account's mail, which must never reach this pane";

/** The reach-past row as the LIST route answers it — a wire DTO, never a mirror row. */
const pastRow = () => ({
  id: listId, accountId: "acct_live_1", mailboxId: listMailbox, threadId: null, messageIdHeader: null,
  subject: "an old receipt", from: { name: "Old Sender", address: "old@example.invalid" },
  to: [], cc: [], date: OLD, folder: "Receipts", snippet: "snippet of the old receipt",
  unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {},
  triage: null, labels: [], remoteContent: "none", updatedAt: OLD,
});

/** One /sync page: the folder entity alone — the folder's mail all lives beyond the mirror. */
const world = (): Response =>
  json({
    changes: { creates: [folderEntity(1)], updates: [], moves: [], deletes: [] },
    cursor: "c1", hasMore: false, serverTime: ISO,
  });

/** URLs the wrapped fetch saw, so the list ask's address can be asserted. */
let asked: string[] = [];
/** What `GET /messages/:id/body` answers next. */
let bodyAnswer: () => Response = () => json({ messageId: PAST_ID, text: BODY_TEXT, html: null, loadedRemoteContent: false });

/**
 * Interpose on the harness's fetch: the reach-past list and the body read get real answers,
 * everything else keeps the fixture's behaviour. Installed AFTER `installShellEnv`, which owns
 * the base mock.
 */
function interposeReachPast(): void {
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = String(input);
    if (url.includes("/messages?")) {
      asked.push(url);
      return json({ items: [pastRow()], nextCursor: null });
    }
    if (/\/messages\/[^/]+\/body/.test(url)) {
      asked.push(url);
      return bodyAnswer();
    }
    return (base as (i: unknown, o?: unknown) => Promise<Response>)(input, init);
  }) as typeof globalThis.fetch;
}

const goHash = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  await tick(0);
};

/** Mount folders-on over an empty-in-mirror folder and open it — every walk's first move. */
async function openFolder(facts = [mailbox()]): Promise<HTMLElement> {
  answerConsentWith({ foldersEnabledAt: ISO });
  answerSyncWith(world);
  // The store holds the row its list route answers, so its timeline says the mirror lacks mail.
  answerStoreWith([{ id: listId, date: OLD }]);
  const el = await mountShell(facts);
  await tick(30_000);
  await goHash(`#/folder/${FOLDER_ID}`);
  await tick(1_000);
  return el;
}

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  asked = [];
  listId = PAST_ID;
  listMailbox = "mb_1";
  bodyAnswer = () => json({ messageId: PAST_ID, text: BODY_TEXT, html: null, loadedRemoteContent: false });
  interposeReachPast();
});
afterEach(async () => {
  // Cleared HERE and not at the end of the case that sets it: a failing assertion skips the
  // tail of its own test, and a `tf_owner` left behind makes every later case in the file sign
  // itself out — a leak that reads as four unrelated regressions.
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  await teardownShellEnv();
});

describe("the door's dispatch is single-flight, decided outside the state updater", () => {
  /**
   * The dispatch claims its slot in a ref BEFORE any state is written — React's own contract
   * (updaters must be pure; a first draft fired the wire call inside one, which under
   * `<StrictMode>`'s development double-invocation is a doubled request per open — the desktop
   * roots both mount StrictMode). This harness cannot observe the double-invocation itself
   * (measured: the mutated updater-dispatch shape still billed once here), so what is PINNED is
   * the functional contract the fix rests on: one open bills one request under a StrictMode
   * mount, and a re-open of a settled row bills none. The purity itself is held by the code's
   * structure — no wire call inside any updater — which review owns rather than this file.
   */
  it("one open under a StrictMode mount issues exactly one wire request, and a re-open none", async () => {
    const { useOlderBody } = await import("../app/shell/older-body");
    const React = (await import("react")) as typeof import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

    let calls = 0;
    const wire = {
      body: async () => {
        calls += 1;
        return {
          kind: "ok" as const, text: "t", html: null, loadedRemoteContent: false,
          unsubscribe: "no_header" as const, unsubscribeUrl: null, withheld: null,
        };
      },
    };
    let door: ReturnType<typeof useOlderBody> | null = null;
    function Probe(): null {
      door = useOlderBody(true, wire);
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(React.StrictMode, null, React.createElement(Probe)));
    });
    await act(async () => {
      door!.open("m1");
      await Promise.resolve();
    });
    expect(calls, "a doubled render pass billed a second request").toBe(1);
    // …and the session cache holds: a second open of the same row asks nothing.
    await act(async () => {
      door!.open("m1");
      await Promise.resolve();
    });
    expect(calls).toBe(1);
    await act(async () => root.unmount());
    host.remove();
  });

  /**
   * ═══ THE DOOR THAT DOES NOT GO THROUGH THE ADAPTER, AND SO NEEDS ITS OWN ANSWER ══════════
   *
   * Every other read in the app reaches the server through the engine's adapter, which the
   * mirror's sync gate wraps — so when the browser's session turns out to belong to a different
   * account than the mirror on screen, those reads refuse in one place. This one does not: it is
   * a bare `api()` call, because a reach-past row is by definition not in the mirror.
   *
   * That made it the WIDEST door rather than the narrowest. The ids it opens come from
   * `useOlderMail`'s list, which under a foreign session is a list of that account's mail — so
   * the id is valid, the request succeeds, and this pane renders somebody else's message in
   * full. The predicate is the caller's; what is pinned here is that the door asks it, asks it
   * at REQUEST time rather than at render time, and turns a refusal into the failed face rather
   * than into a row that sits on its snippet with nothing to press.
   */
  it("asks the caller's predicate before every request, and fails the row when it says no", async () => {
    const { useOlderBody } = await import("../app/shell/older-body");
    const React = (await import("react")) as typeof import("react");
    const { createRoot } = await import("react-dom/client");
    const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

    let calls = 0;
    const wire = {
      body: async () => {
        calls += 1;
        return {
          kind: "ok" as const, text: "another account's mail", html: null,
          loadedRemoteContent: false, unsubscribe: "no_header" as const,
          unsubscribeUrl: null, withheld: null,
        };
      },
    };
    // Read at CALL time, not at render time: the cookie this stands for is rewritten by a
    // sign-in in another tab, which re-renders nothing here.
    let mayRead = true;
    let door: ReturnType<typeof useOlderBody> | null = null;
    function Probe(): null {
      door = useOlderBody(true, wire, () => mayRead);
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(Probe)); });

    // THE CONTROL FIRST — the door has to be shown fetching, or the refusal below is green over
    // a door that was inert all along.
    await act(async () => { door!.open("m_ok"); await Promise.resolve(); });
    expect(calls, "the door never fetched, so the refusal below proves nothing").toBe(1);
    expect(door!.bodyFor({ id: "m_ok", snippet: "s" }).state).toBe("full");

    mayRead = false;
    await act(async () => { door!.open("m_foreign"); await Promise.resolve(); });
    expect(calls, "a reach-past body was fetched under another account's session").toBe(1);
    // `failed`, not a silent snippet: the row says it could not be loaded and offers a Retry,
    // which is the honest face for a refusal that a later sign-in can clear.
    expect(door!.bodyFor({ id: "m_foreign", snippet: "s" }).state).toBe("failed");

    await act(async () => root.unmount());
    host.remove();
  });
});

describe("the reach-past body door, through the shipped shell", () => {
  it("the list ask carries the folder's whole address, and the opened row renders its full body", async () => {
    const el = await openFolder();

    // The empty-mirror probe fired once and named the folder ENTITY id — the address whose
    // dropping is exactly how the sidecar half of this defect died.
    const listAsks = asked.filter((u) => u.includes("/messages?"));
    expect(listAsks.length).toBeGreaterThan(0);
    expect(listAsks[0]).toContain("view=folder");
    expect(listAsks[0]).toContain(`folderId=${FOLDER_ID}`);

    // The row is on screen, from beyond the device's window…
    expect(textOf(el)).toContain("an old receipt");

    // …and its body arrived through the door: the FULL text, not the snippet, not the stall
    // face. The pane auto-selects the only row, so no click is needed — the same path a person
    // takes.
    await tick(2_000);
    expect(textOf(el)).toContain(BODY_TEXT);
    expect(asked.some((u) => u.includes(`/messages/${PAST_ID}/body`))).toBe(true);
    expect(textOf(el)).not.toContain("Couldn't load the full message");
  });

  /**
   * ═══ AND THE SHELL ACTUALLY HANDS THE DOOR ITS PREDICATE ═════════════════════════════════
   *
   * The unit case above proves the door asks. This proves the SHIPPED shell gives it something
   * to ask — a wiring that is invisible when it is missing, because the door works perfectly
   * without it and simply answers for the wrong account.
   *
   * ── WHY IT IS THE RETRY BUTTON AND NOT AN ORDINARY OPEN ─────────────────────────────────
   *
   * A row already fetched is answered from the door's session cache, so re-opening one issues
   * no request whatever the predicate says — a first draft of this walk did exactly that and
   * stayed green with the wiring deleted. And a row from a LIST fetched after the flip never
   * arrives at all: `listMessages` is gated too, so the pane has nothing to open. What is left
   * is the case that isolates this door: a row listed while the jar still agreed, whose body
   * FAILED, whose Retry is pressed after the jar has been rewritten. The list is already in
   * hand; the press goes straight to the door; nothing else can refuse it.
   */
  it("the Retry on a reach-past row fetches nothing once the browser holds another session", async () => {
    bodyAnswer = () => { throw new TypeError("network down"); };
    const el = await openFolder();
    await tick(2_000);
    const pane = el.querySelector(".view-folder") as HTMLElement;
    expect(pane.textContent ?? "", "the row never reached the failed face, so the Retry proves nothing")
      .toContain("Couldn't load the full message");
    const before = asked.filter((u) => u.includes("/body")).length;
    expect(before, "the door never asked at all").toBeGreaterThan(0);

    // Somebody signs in as another account in a second tab. The jar is rewritten; this tree
    // re-renders nothing and holds the very same engine.
    document.cookie = "tf_owner=acct_someone_else; Path=/";
    bodyAnswer = () => json({ messageId: PAST_ID, text: FOREIGN_TEXT, html: null, loadedRemoteContent: false });

    const retry = [...pane.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry");
    expect(retry, "the failed face offered no Retry").toBeTruthy();
    await act(async () => { (retry as HTMLButtonElement).click(); await Promise.resolve(); });
    await tick(2_000);

    expect(asked.filter((u) => u.includes("/body")).length,
      "a body was fetched while the browser's session belonged to another account").toBe(before);
    expect(textOf(el)).not.toContain(FOREIGN_TEXT);
  });

  it("a policy-withheld body says so honestly, with no Retry", async () => {
    bodyAnswer = () =>
      json({ messageId: PAST_ID, text: "", html: null, loadedRemoteContent: false, withheld: "storage_cap" });
    const el = await openFolder();
    await tick(2_000);

    // The storage-cap sentence, verbatim from the catalogue — a terminal state.
    expect(textOf(el)).toContain(en.body.withheld);
    // It says why and where the letter is, and that its text comes back once there is room.
    expect(textOf(el)).toContain("to stay within your plan's storage space");
    expect(textOf(el)).toContain("complete in your mailbox on your mail server");
    expect(textOf(el)).toContain("When there is room again, ohmail fetches this text back from your mail server.");
    // And no body-retry control anywhere in the reading column: a retry cannot change a policy.
    const pane = el.querySelector(".view-folder") as HTMLElement;
    const retries = [...pane.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Retry");
    expect(retries).toHaveLength(0);
  });

  it("a letter of a removed mailbox says its text does not come back, from the shell's mailbox facts", async () => {
    listMailbox = "mb_gone";
    bodyAnswer = () =>
      json({ messageId: PAST_ID, text: "", html: null, loadedRemoteContent: false, withheld: "storage_cap" });
    const el = await openFolder([
      mailbox({ id: "mb_1" }), mailbox({ id: "mb_gone", address: "gone@example.invalid", status: "disabled" }),
    ]);
    await tick(2_000);
    expect(textOf(el)).toContain("ohmail no longer reads this mailbox, so this text does not come back here.");
    expect(textOf(el)).toContain("complete in your mailbox on your mail server");
    expect(textOf(el)).not.toContain("room again");
  });

  it("a row the account no longer holds renders the expunged sentence, with no Retry", async () => {
    bodyAnswer = () => json({ error: { code: "not_found", message: "message not found" } }, 404);
    const el = await openFolder();
    await tick(2_000);

    expect(textOf(el)).toContain(en.body.withheldExpunged);
    const pane = el.querySelector(".view-folder") as HTMLElement;
    const retries = [...pane.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Retry");
    expect(retries).toHaveLength(0);
  });

  it("a transport failure offers a Retry that actually works", async () => {
    let failures = 0;
    bodyAnswer = () => {
      failures += 1;
      return json({ error: { code: "internal", message: "boom" } }, 500);
    };
    const el = await openFolder();
    await tick(2_000);

    // The honest failed face — and this time there IS a request behind it that failed.
    expect(textOf(el)).toContain("Couldn't load the full message");
    expect(failures).toBeGreaterThan(0);

    // The press dispatches a REAL second ask; the server has recovered; the body renders.
    bodyAnswer = () => json({ messageId: PAST_ID, text: BODY_TEXT, html: null, loadedRemoteContent: false });
    const pane = el.querySelector(".view-folder") as HTMLElement;
    const retry = [...pane.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry");
    expect(retry, "the failed face lost its Retry").toBeTruthy();
    await act(async () => {
      (retry as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await tick(2_000);
    expect(textOf(el)).toContain(BODY_TEXT);
  });
});
