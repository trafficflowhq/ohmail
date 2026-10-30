/**
 * FOLDERS, STAGE 1, ON A REAL WIRE — the read-only parity slice (FOLDERS-SPEC.md; the webapp's
 * foundation is the reference): `folder` entities off /sync into the mirror, the consent
 * read/write the Settings toggle rides, and the projection's §16.5 lens that keeps a user
 * folder's mail visible in its folder view.
 *
 * What bites, per surface:
 *  · the LENS IS THE FLAG's — `presentedOf(reader, now, foldersEnabled)` must carry the
 *    consent answer into `consentPartition`, or a dormant sender's read mail (most of what an
 *    archive folder holds) is a History drop and the folder view loses it. Both directions are
 *    measured: off ⇒ dropped, on ⇒ placed at its folder.
 *  · the consent seam holds no origin of its own — `GET /consent` answers the flag,
 *    `PATCH /consent/settings` moves it, a transport failure reads as "could not ask" (null),
 *    never as off.
 *  · the pure tree arithmetic is the webapp's: parents before children, numeric-aware
 *    alphabetical siblings, the opened-set walk, roll-up counts on a collapsed parent.
 */
import { describe, expect, it } from "vitest";
import { ohboxView, type EngineMessage } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { readFoldersEnabled, writeFoldersEnabled } from "../src/net/consent";
import type { ConnectedSession } from "../src/net/pairing";
import {
  liveFolder,
  liveFolders,
  liveFolderUnread,
  presentedOf,
  screeningAnswered,
  type FolderEntity,
} from "../src/state/live";
import {
  FOLDER_FILTER_AT,
  folderMatches,
  folderTree,
  folderUnreadCounts,
  folderUnreadDeep,
  visibleFolderRows,
} from "../src/state/folders";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

/** A minimal session for the consent seam: ONE origin, a plain fetch — the seam needs no more. */
function sessionFor(origin: string): ConnectedSession {
  return {
    profile: { origin },
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  } as unknown as ConnectedSession;
}

async function bootOn(origin: string) {
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity(); // the app's own sequence: the verdict opens the drain routes
  await boot.engine.start();
  return boot;
}

const F = (id: string, name: string, mailboxId = "mb-1", mailbox = "owner@fake.test"): FolderEntity =>
  ({ id, name, mailboxId, mailbox });

describe("the folder tree arithmetic — the webapp shell's, held by behaviour", () => {
  const folders = [
    F("f-b", "Beta"),
    F("f-a", "Alpha"),
    F("f-a2", "Alpha/Inner"),
    F("f-a21", "Alpha/Inner/Deep"),
    F("f-s10", "Steuern 2010"),
    F("f-s9", "Steuern 2009"),
    F("f-orphan", "Ghost/Child"),
  ];

  it("parents before children, siblings numeric-aware alphabetical, orphans as roots", () => {
    const tree = folderTree(folders);
    expect(tree.map((r) => r.folder.name)).toEqual([
      "Alpha", "Alpha/Inner", "Alpha/Inner/Deep", "Beta", "Ghost/Child",
      "Steuern 2009", "Steuern 2010",
    ]);
    expect(tree.map((r) => r.depth)).toEqual([0, 1, 2, 0, 0, 0, 0]);
  });

  it("the opened-set walk shows first level only by default and opens per branch", () => {
    const tree = folderTree(folders);
    const kids = (p: string) => folders.some((f) => f.name.startsWith(p + "/"));
    const closed = visibleFolderRows(tree, () => false, kids);
    expect(closed.map((r) => r.folder.name)).toEqual([
      "Alpha", "Beta", "Ghost/Child", "Steuern 2009", "Steuern 2010",
    ]);
    const alphaOpen = visibleFolderRows(tree, (p) => p === "Alpha", kids);
    expect(alphaOpen.map((r) => r.folder.name)).toEqual([
      "Alpha", "Alpha/Inner", "Beta", "Ghost/Child", "Steuern 2009", "Steuern 2010",
    ]);
  });

  it("a collapsed parent's badge rolls up every hidden descendant — unread truth never hides", () => {
    const counts = folderUnreadCounts([
      { mailboxId: "mb-1", folder: "Alpha", unread: true },
      { mailboxId: "mb-1", folder: "Alpha/Inner", unread: true },
      { mailboxId: "mb-1", folder: "Alpha/Inner/Deep", unread: true },
      { mailboxId: "mb-1", folder: "Alpha/Inner/Deep", unread: false },
      { mailboxId: "mb-2", folder: "Alpha/Inner", unread: true }, // another mailbox's Alpha
    ]);
    expect(folderUnreadDeep("mb-1", "Alpha", counts, folders)).toBe(3);
    expect(counts.get("mb-1|Alpha")).toBe(1);
  });

  it("the filter predicate matches the FULL path, so path queries reach children", () => {
    expect(folderMatches("Alpha/Inner", "inner")).toBe(true);
    expect(folderMatches("Alpha/Inner", "alpha/")).toBe(true);
    expect(folderMatches("Beta", "alpha")).toBe(false);
    expect(FOLDER_FILTER_AT).toBe(12);
  });
});

describe("the consent seam — GET /consent and PATCH /consent/settings on the paired origin", () => {
  it("reads the flag, writes it, and renders the SERVER's answer", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    const session = sessionFor(origin);
    // The read carries the signatures map beside the flag (mail 0075) — absent on the wire
    // (a pre-0075 server, this fake's default) reads as the empty map, never as a failure — and
    // the account's appearance face (OHMARCHY-PLAN.md §3a), absent on this default wire too,
    // which reads as "no preference" rather than as paper. `ohmarchy-face.test.ts` owns that
    // field's own cases; it appears here because the READ's shape is one object.
    // `screening` is the CUTLINE half of the same body (mail 0056/0083) — the phone partitions
    // its mirror with the account's answer rather than the engine's default.
    // `storable` is the second fact the same body carries: whether the answer carries the
    // `foldersEnabledAt` axis AT ALL. This fake serves the managed table's shape, which does —
    // a door built from `localRoutes` removes the field, and `paired-folders-door.test.ts`
    // drives that one against the real stripper.
    const WINDOW = { dormancyDays: 21, baselineAt: null, scope: "window" };
    // `resurfaceTime: null` is "this account has never chosen an hour" (mail 0110), which every
    // reader draws as the product's 09:00 — the whole-object shape is asserted so a field added
    // to this read has to be decided here rather than arriving unnoticed. `autoAct: null` is a
    // server whose answer carries no act axis (this fake's), which draws no switch; `autoSuggestOn`
    // is what that switch needs, off here.

    expect(await readFoldersEnabled(session))
      .toEqual({ on: false, storable: true, screening: WINDOW, signatures: {}, themeFace: null,
        resurfaceTime: null, autoUnsubscribe: true, autoAct: null, autoSuggestOn: false, seed: null });
    expect(await writeFoldersEnabled(session, true)).toEqual({ on: true });
    expect(fake.foldersOn()).toBe(true);
    expect(await readFoldersEnabled(session))
      .toEqual({ on: true, storable: true, screening: WINDOW, signatures: {}, themeFace: null,
        resurfaceTime: null, autoUnsubscribe: true, autoAct: null, autoSuggestOn: false, seed: null });
    expect(await writeFoldersEnabled(session, false)).toEqual({ on: false });
    expect(fake.foldersOn()).toBe(false);
    fake.server.close();
  });

  it("the signatures map rides the same read — string values kept, anything malformed dropped", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    const session = sessionFor(origin);
    fake.setSignatures({ "mb-1": "Casey Reeve\nohmail", "mb-2": "" });
    expect((await readFoldersEnabled(session))!.signatures).toEqual({ "mb-1": "Casey Reeve\nohmail", "mb-2": "" });
    // A malformed wire value (a server bug, a proxy mangling) reads as absent — the block
    // must never render from a shape that is not `{ mailboxId: string }`.
    fake.setSignatures(42 as unknown as Record<string, string>);
    expect((await readFoldersEnabled(session))!.signatures).toEqual({});
    fake.setSignatures({ "mb-1": 7 } as unknown as Record<string, string>);
    expect((await readFoldersEnabled(session))!.signatures).toEqual({});
    fake.server.close();
  });

  it("the sent-mail seed rides the same read: never confirmed, confirmed, or a door without it", async () => {
    const fake = mailServer();
    const session = sessionFor(await listen(fake.server));
    fake.setSeedConfirmedAt(null);
    expect((await readFoldersEnabled(session))!.seed).toEqual({ confirmedAt: null });
    fake.setSeedConfirmedAt("2026-10-24T05:00:00.000Z");
    expect((await readFoldersEnabled(session))!.seed).toEqual({ confirmedAt: "2026-10-24T05:00:00.000Z" });
    fake.setSeedConfirmedAt(undefined);
    expect((await readFoldersEnabled(session))!.seed, "an absent field is a door with no seed, not one owed").toBeNull();
    fake.server.close();
  });

  it("could-not-ask is null, never off — and a refused write throws", async () => {
    // A dead port: the read answers null (the caller keeps its last answer), it does not lie "off".
    expect(await readFoldersEnabled(sessionFor("http://127.0.0.1:1"))).toBeNull();
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.failNext("PATCH", "/consent/settings");
    await expect(writeFoldersEnabled(sessionFor(origin), true)).rejects.toThrow();
    expect(fake.foldersOn()).toBe(false);
    fake.server.close();
  });
});

describe("folder entities and the §16.5 lens, through the real engine", () => {
  /** One world: a folder entity, a READ message in it from a long-quiet, undecided sender. */
  async function folderScene() {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addFolder("fld-1", "Projects/Acme");
    fake.addMessage(dto("m-arch", {
      subject: "Q1 files",
      folder: "Projects/Acme",
      unread: false,
      date: "2026-01-05T08:00:00Z", // far past any dormancy window measured from today
      from: { name: "Old Vendor", address: "vendor@quiet.test" }, // no rule anywhere
    }));
    fake.addMessage(dto("m-arch-new", {
      subject: "Q3 files",
      folder: "Projects/Acme",
      unread: true,
      date: new Date().toISOString(),
      from: { name: "Old Vendor", address: "vendor@quiet.test" },
    }));
    const boot = await bootOn(origin);
    return { fake, boot };
  }

  it("the mirror carries the folder entity, and liveFolders lists it", async () => {
    const { fake, boot } = await folderScene();
    const folders = liveFolders(boot.engine.read());
    expect(folders.map((f) => f.name)).toEqual(["Projects/Acme"]);
    expect(folders[0]!.mailboxId).toBe("mb-1");
    boot.store.close();
    fake.server.close();
  });

  it("flag OFF drops the dormant read row from the projection; flag ON keeps it AT its folder", async () => {
    const { fake, boot } = await folderScene();
    const now = new Date();
    // Off: the pre-feature partition — the quiet sender's read mail is History, and History
    // rows leave the presented list entirely.
    // The WINDOW is stated rather than defaulted: neither posture without an answer retires
    // anybody (`live.ts#ScreeningPosture` partitions both at `all_time`), so the drop this test
    // is about needs the account's own answer to exist.
    const answer = screeningAnswered({ dormancyDays: null, baselineAt: null, scope: "window" });
    const off = presentedOf(boot.engine.read(), now, false, answer);
    expect(off.get<EngineMessage>("message", "m-arch")).toBeUndefined();
    // On: the lens keeps the folder-filed row placed at its folder (spec §16.5) — the folder
    // view can show it and the reader can open it.
    const on = presentedOf(boot.engine.read(), now, true, answer);
    expect(on.get<EngineMessage>("message", "m-arch")?.folder).toBe("Projects/Acme");
    boot.store.close();
    fake.server.close();
  });

  it("liveFolder lists the folder's mail unread-first with the leaf-named rows", async () => {
    const { fake, boot } = await folderScene();
    const now = new Date();
    const v = { now, zone: "UTC", foldersEnabled: true };
    const pres = presentedOf(boot.engine.read(), now, true);
    const folder = liveFolders(boot.engine.read())[0]!;
    const view = liveFolder(pres, folder, v);
    expect(view.total).toBe(2);
    expect(view.unread).toBe(1);
    expect(view.fresh.map((m) => m.id)).toEqual(["m-arch-new"]);
    expect(view.seen.map((m) => m.id)).toEqual(["m-arch"]);
    // The row names itself by the folder's LEAF — never a raw path, never the "Ohbox" fallback.
    expect(view.seen[0]!.folderLeaf).toBe("Acme");
    boot.store.close();
    fake.server.close();
  });

  it("the mailbox's recorded 'Envoyés' keeps its old letters in the folder and out of Earlier", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addFolder("fld-fr", "Envoyés");
    const own = { name: "Owner", address: "owner@fake.test" };
    fake.addMessage(dto("fr-new", { folder: "Envoyés", unread: false, date: new Date().toISOString(), from: own }));
    fake.addMessage(dto("fr-old", { folder: "Envoyés", unread: false, date: "2026-01-05T08:00:00Z", from: own }));
    const boot = await bootOn(origin);
    try {
      boot.engine.setSentFolders([{ id: "mb-1", sentFolder: "Envoyés" }]);
      const now = new Date();
      const answer = screeningAnswered({ dormancyDays: null, baselineAt: null, scope: "window" });
      const pres = presentedOf(boot.engine.read(), now, true, answer);
      const folder = liveFolders(boot.engine.read()).find((f) => f.name === "Envoyés")!;
      expect(liveFolder(pres, folder, { now, zone: "UTC", foldersEnabled: true }).seen.map((m) => m.id))
        .toEqual(["fr-new", "fr-old"]);
      expect(ohboxView(pres).previouslySeen.map((m) => m.id)).toEqual(["fr-new"]);
    } finally {
      boot.engine.setSentFolders([]);
      boot.store.close();
      fake.server.close();
    }
  });

  it("liveFolderUnread counts per (mailbox, folder) over the projection", async () => {
    const { fake, boot } = await folderScene();
    const pres = presentedOf(boot.engine.read(), new Date(), true);
    const unread = liveFolderUnread(pres);
    expect(unread.get("mb-1|Projects/Acme")).toBe(1);
    boot.store.close();
    fake.server.close();
  });
});
