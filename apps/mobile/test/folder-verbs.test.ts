/**
 * THE FOLDER VERBS ON A REAL WIRE — stage 2 (FOLDERS-SPEC.md §18) through the same
 * `bootEngine` composition the app runs, against the loopback mail server: the world layer's
 * `folderCreate` / `folderRename` / `folderDelete` / `folderDismiss` arms dispatching the
 * engine's own `folder_*` mutations, plus the one read beside them (`GET /folders/:id/summary`).
 *
 * What bites, per verb (the family's optimism model — pending MARKERS, never pretended
 * completion):
 *  · CREATE posts `{mailboxId, name}`; the mirror's row wears `op:{kind:"create"}` and the
 *    server's echo replaces the client-local id in the same breath (two ids never coexist);
 *  · RENAME patches the new FULL path; `name` stays the MAILBOX's truth while `op.to` carries
 *    the commanded target — every join keeps running on `name`;
 *  · DELETE ghosts the row (`op:{kind:"delete"}`) rather than dropping it — the failure's
 *    honest sentence needs a row to stand on;
 *  · a REFUSED command rolls back whole and speaks the ONE failure sentence; success says
 *    nothing (the pending row is the feedback) — `folder-verbs.ts`'s `speakIfRolledBack`;
 *  · DISMISS on a failed create takes the never-created row with it;
 *  · the summary read answers the server's counts, and `null` — never a guess — when the
 *    route refuses or the wire is dead (the confirm's uncounted sentence).
 */
import type { FolderEntity } from "@ohmail/wire";
import { describe, expect, it, vi } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { readFolderSummary } from "../src/net/folder-ops";
import type { ConnectedSession } from "../src/net/pairing";
import { liveActions, soleMessageMailbox, type LiveWorldActions } from "../src/state/live";
import { Copy } from "../src/copy";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
import { arrived, CASE_MS } from "./helpers/arrived";

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };

/** A minimal session for the summary seam: ONE origin, a plain fetch — the seam needs no more. */
function sessionFor(origin: string): ConnectedSession {
  return {
    profile: { origin },
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  } as unknown as ConnectedSession;
}

async function scene(extra: (fake: ReturnType<typeof mailServer>) => void = () => undefined) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  extra(fake);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine,
    toast: (m) => toasts.push(sayArg(m)),
    uuid,
    zone: "UTC",
  });
  return { fake, origin, ...boot, actions, toasts };
}

const wire = (fake: ReturnType<typeof mailServer>, method: string, path: string) =>
  fake.seen.filter((r) => r.method === method && r.url === path);

const foldersOf = (engine: { read(): { list<T>(t: string): T[] } }): FolderEntity[] =>
  engine.read().list<FolderEntity>("folder");

describe("create — POST /folders, the pending marker, the echo's id", () => {
  it("posts the full path for the named mailbox and lands the SERVER's pending row", async () => {
    const live = await scene((f) => f.addFolder("fld-0", "Existing"));
    expect(await live.actions.folderCreate("mb-1", "Projects")).toBe(true);
    const posts = wire(live.fake, "POST", "/folders");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.body)).toEqual({ mailboxId: "mb-1", name: "Projects" });
    const rows = foldersOf(live.engine).filter((f) => f.name === "Projects");
    // Exactly one row — the server echo REPLACED the optimistic client-local id (the
    // two-ids-never-coexist rule); it wears the pending marker until the worker executes.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("f-2");
    expect(rows[0]!.op).toEqual({ kind: "create" });
    // Success says nothing — the pending row itself is the feedback.
    expect(live.toasts).toEqual([]);
    live.store.close();
    live.fake.server.close();
  });

  it("without a uuid source the create is refused rather than minted weakly", async () => {
    const live = await scene();
    const bare = liveActions({ engine: live.engine, toast: () => undefined, zone: "UTC" });
    expect(await bare.folderCreate("mb-1", "Projects")).toBe(false);
    expect(wire(live.fake, "POST", "/folders")).toHaveLength(0);
    live.store.close();
    live.fake.server.close();
  });

  it("a refused create rolls back whole — no row, and the one failure sentence", async () => {
    const live = await scene();
    live.fake.failNext("POST", "/folders");
    expect(await live.actions.folderCreate("mb-1", "Projects")).toBe(false);
    expect(live.toasts).toContain(Copy.folderVerbFailed);
    expect(foldersOf(live.engine).filter((f) => f.name === "Projects")).toHaveLength(0);
    live.store.close();
    live.fake.server.close();
  });
});

describe("rename — PATCH /folders/:id, the commanded target beside the mailbox's truth", () => {
  it("patches the new full path; `name` holds, `op.to` carries the target", async () => {
    const live = await scene((f) => f.addFolder("fld-1", "Projects"));
    expect(await live.actions.folderRename("fld-1", "Clients")).toBe(true);
    const patches = wire(live.fake, "PATCH", "/folders/fld-1");
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0]!.body)).toEqual({ name: "Clients" });
    const row = live.engine.read().get<FolderEntity>("folder", "fld-1")!;
    // The mailbox's truth until the worker lands the swap — every join stays on `name`.
    expect(row.name).toBe("Projects");
    expect(row.op).toEqual({ kind: "rename", to: "Clients" });
    live.store.close();
    live.fake.server.close();
  });

  it("a refused rename rolls the marker back and speaks", async () => {
    const live = await scene((f) => f.addFolder("fld-1", "Projects"));
    live.fake.failNext("PATCH", "/folders/fld-1");
    expect(await live.actions.folderRename("fld-1", "Clients")).toBe(false);
    expect(live.toasts).toContain(Copy.folderVerbFailed);
    expect(live.engine.read().get<FolderEntity>("folder", "fld-1")!.op).toBeUndefined();
    live.store.close();
    live.fake.server.close();
  });
});

describe("delete — the ghosting marker, then the tombstones' drain", () => {
  it("DELETE /folders/:id ghosts the row rather than dropping it", async () => {
    const live = await scene((f) => f.addFolder("fld-1", "Projects"));
    expect(await live.actions.folderDelete("fld-1")).toBe(true);
    expect(wire(live.fake, "DELETE", "/folders/fld-1")).toHaveLength(1);
    const row = live.engine.read().get<FolderEntity>("folder", "fld-1")!;
    expect(row.op).toEqual({ kind: "delete" });
    live.store.close();
    live.fake.server.close();
  });
});

describe("dismiss — a FAILED command's refusal was read", () => {
  it("a failed create's dismiss takes the never-created row with it", async () => {
    const live = await scene();
    await live.actions.folderCreate("mb-1", "Projects");
    // The worker refuses server-side; the refusal rides the next drain.
    live.fake.settleFolder("f-1", { failWith: "exists" });
    await live.engine.syncOnce();
    expect(live.engine.read().get<FolderEntity>("folder", "f-1")!.op).toEqual({ kind: "create", error: "exists" });
    live.actions.folderDismiss("f-1");
    await arrived("the dismiss's DELETE /folders/f-1/op", () => wire(live.fake, "DELETE", "/folders/f-1/op").length >= 1);
    await arrived("f-1 gone from the mirror", () => live.engine.read().get<FolderEntity>("folder", "f-1") === undefined,
      () => JSON.stringify(live.engine.read().get<FolderEntity>("folder", "f-1")?.op ?? null));
    expect(wire(live.fake, "DELETE", "/folders/f-1/op")).toHaveLength(1);
    expect(live.engine.read().get<FolderEntity>("folder", "f-1")).toBeUndefined();
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);
});

describe("the summary read — server-truth counts or an honest null", () => {
  it("answers the server's counts; a 404 and a dead wire both answer null", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addFolder("fld-1", "Projects");
    // The default is the 404 path — the uncounted sentence's cue.
    expect(await readFolderSummary(sessionFor(origin), "fld-1")).toBeNull();
    fake.setSummary({ folders: 3, messages: 41 });
    expect(await readFolderSummary(sessionFor(origin), "fld-1")).toEqual({ folders: 3, messages: 41 });
    expect(await readFolderSummary(sessionFor("http://127.0.0.1:1"), "fld-1")).toBeNull();
    fake.server.close();
  });

  it("a server that accepts and never answers is the uncounted answer, not a hang", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addFolder("fld-1", "Projects");
    fake.setSummary({ folders: 1, messages: 5 });
    fake.hangNext("GET", "/folders/fld-1/summary");
    // The deadline decides (test seam narrows it): the confirm's "Counting…" must not stand
    // forever with the Delete row withheld — a timeout IS "could not count". On a fake clock:
    // the request is on the wire, open one tick short of the deadline, answered at it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const started = Date.now();
      let settled = false;
      const counted = readFolderSummary(sessionFor(origin), "fld-1", 300).finally(() => { settled = true; });
      while (wire(fake, "GET", "/folders/fld-1/summary").length === 0) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(299);
      expect(settled, "the count gave up before its deadline").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await counted).toBeNull();
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      vi.useRealTimers();
    }
    fake.server.close();
    fake.server.closeAllConnections?.();
  });

  it("the deadline covers the WHOLE bearer promise — a stalled token refresh cannot outlive it", async () => {
    // `BearerManagerRN.fetch` can spend its life awaiting a token rotation whose refresh
    // request carries no abort signal (codex round 2) — modeled here as a bearer promise that
    // never settles at all. The race, not the signal, is what keeps the promise.
    const hungBearer = {
      profile: { origin: "http://127.0.0.1:9" },
      fetch: () => new Promise<Response>(() => undefined),
    } as unknown as ConnectedSession;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const started = Date.now();
      let settled = false;
      const counted = readFolderSummary(hungBearer, "fld-1", 300).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(299);
      expect(settled, "the count gave up before its deadline").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await counted).toBeNull();
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the first create's mailbox — soleMessageMailbox over the raw mirror", () => {
  it("one distinct mailbox answers it; none or several answer null", async () => {
    const live = await scene((f) => {
      f.addMessage(dto("m1"));
      f.addMessage(dto("m2"));
    });
    expect(soleMessageMailbox(live.engine.read())).toBe("mb-1");
    live.store.close();
    live.fake.server.close();

    const two = await scene((f) => {
      f.addMessage(dto("m1"));
      f.addMessage({ ...dto("m2"), mailboxId: "mb-2" } as ReturnType<typeof dto>);
    });
    expect(soleMessageMailbox(two.engine.read())).toBeNull();
    two.store.close();
    two.fake.server.close();

    const none = await scene();
    expect(soleMessageMailbox(none.engine.read())).toBeNull();
    none.store.close();
    none.fake.server.close();
  });
});
