/**
 * A LETTER BEING WRITTEN SURVIVES A HARD STOP — the paired composition (the real engine, its HTTP
 * adapter against the fake origin) over a device disk: the app's own serial lane, and a kill that
 * rolls back what was open and answers nothing more. The composer's half is `letter-keeper.ts`,
 * driven here as the sheet drives it; each next launch runs `world.tsx`'s restore and flush.
 * Measured at the base: a force-stop with a typed letter and a photo left no Drafts row and nothing
 * on the phone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { refuse, sayArg } from "../src/refusal";
import type { MobileEngineDeps } from "../src/engine/boot";
import type { LetterWords } from "../src/compose/letter-keeper";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { deviceDisk } from "./helpers/device-disk";
import { wordsOf } from "../src/compose/letter-store";
import { baseAfter, baseFor, waitedFor, type DraftBase } from "../src/ui/compose-keep";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const holdTheClock = (): void => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); };
const settle = async (n = 40): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

const PHOTO = Buffer.alloc(2048, 7).toString("base64");
const WORDS: LetterWords = {
  mode: "new", messageId: null, mailboxId: "mb-1", to: "peer@fake.test", cc: "", bcc: "",
  subject: "Plans", body: "Half a thought", envelope: null,
};

let uuids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}`;

async function server() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m1", { subject: "Welcome" }));
  return { fake, origin };
}

/** One launch over `disk`: a fresh module graph, a process whose wire dies with it, `world.tsx`'s letters. */
async function launch(
  disk: ReturnType<typeof deviceDisk>, origin: string, opts: { offline?: boolean; revisionOf?: (id: string) => string | undefined } = {},
) {
  vi.resetModules();
  const { bootEngine } = await import("../src/engine/boot");
  const { serialSqlExecutor } = await import("../src/engine/sql-queue");
  const live = await import("../src/state/live");
  const keeping = await import("../src/compose/letter-keeper");
  const restoring = await import("../src/compose/letter-restore");
  const { letterDoor } = await import("../src/compose/letter-store");
  let dead = false;
  /** cut: every write fails as a network error; swallow: a PUT reaches the origin, its answer never comes back. */
  /** held: the first request of that method waits for `until` (a link slower than the replay deadline). */
  const net = { offline: opts.offline === true, cut: false, swallow: false, held: null as null | { method: string; until: Promise<void> } };
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    if (dead) return never();
    const held = net.held;
    if (held && init?.method === held.method) { net.held = null; return held.until.then(() => fetch(url, init)); }
    if (net.offline && init?.method === "POST") return Promise.reject(new TypeError("Network request failed"));
    if (net.cut && (init?.method ?? "GET") !== "GET") return Promise.reject(new TypeError("Network request failed"));
    if (net.swallow && init?.method === "PUT") { void globalThis.fetch(url, init).catch(() => undefined); return never(); }
    // The send route's version check (SendService), which the fake's own send route does not make.
    const send = /^\/drafts\/([^/]+)\/send$/.exec(new URL(url).pathname);
    const stated = send && typeof init?.body === "string" ? (JSON.parse(init.body) as { ifContentRevision?: string }).ifContentRevision : undefined;
    if (send && stated && opts.revisionOf && opts.revisionOf(decodeURIComponent(send[1]!)) !== stated) {
      return Promise.resolve(new Response(JSON.stringify({ error: { code: "draft_changed", message: "This draft changed elsewhere." } }), {
        status: 409, headers: { "content-type": "application/json" },
      }));
    }
    return globalThis.fetch(url, init).then((r) => (dead ? never<Response>() : r));
  };
  const files = disk.opener(serialSqlExecutor);
  const deps: MobileEngineDeps = { openExecutor: files.open, deleteDatabase: files.drop, fetch, uuid };
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const engine = boot.engine;
  const said: string[] = [];
  const toast = (m: Parameters<typeof sayArg>[0]) => { said.push(sayArg(m)); };
  const letters = letterDoor(boot.store);
  keeping.openLetterSession({ door: letters, uuid });
  const actions = live.liveActions({ engine, uuid, zone: "UTC", toast, letters });
  const flushWaiters: (() => void)[] = [];
  let asked = (): void => undefined;
  /** A restore waits on the reconnect flush. */
  const waitsOnFlush = new Promise<void>((r) => { asked = r; });
  const restoreDeps = {
    door: letters,
    outbox: () => [...engine.pendingMutations(), ...engine.inFlightMutations()].map((p) => ({ key: p.key, mutation: p.mutation })),
    keep: (k: Parameters<typeof actions.draftKeep>[0]) => actions.draftKeep(k),
    hasMessage: (id: string) => engine.read().get("message", id) !== undefined,
    drafts: () => engine.read().entries<Record<string, unknown>>("draft").map((e) => ({ ...e.entity, id: e.id })),
    firstSync: () => engine.syncOnce().then(() => undefined),
    afterFlush: () => { asked(); return new Promise<void>((r) => { flushWaiters.push(r); }); },
    parse: live.keptRecipients,
    keptAsNew: () => engine.keptAsNewDrafts(),
  };
  /** `world.tsx`'s restore, as the session runs it. */
  const restore = async () => {
    const r = await restoring.restoreLetters({ ...restoreDeps, owned: keeping.ownedLetters() });
    const say = restoring.sayLetterRestore(r);
    if (say !== null) toast(say);
    return r;
  };
  /** `world.tsx`'s reconnect flush, letters settled by key. */
  const flush = async () => {
    const settled = await live.flushQueued(engine, actions.releaseConfirmed);
    const loose = restoring.settleLetters(letters, keeping.ownedLetters(), settled);
    for (const go of flushWaiters.splice(0)) go();
    for (const say of live.sayFlushedSaves(settled)) toast(say);
    if (loose.length > 0) {
      const r = await restoring.restoreLetters({ ...restoreDeps, owned: keeping.ownedLetters(), only: new Set(loose.map((x) => x.letter)) });
      toast(refuse(r.kept > 0 ? "replyChangedElsewhere" : "replyChangedElsewhereLater"));
    }
    return settled;
  };
  /** The sheet, opened: its letter on this launch's disk. */
  const compose = (o: { id?: string; draftId?: string; savedAs?: string; revision?: string; words?: LetterWords } = {}) => keeping.openLetterKeeper({
    door: letters, id: o.id ?? uuid(), newFileId: uuid, words: o.words ?? WORDS,
    ...(o.draftId ? { draftId: o.draftId, savedAs: o.savedAs ?? null, revision: o.revision ?? null } : {}),
  });
  return { engine, store: boot.store, actions, letters, said, restore, flush, waitsOnFlush, compose, net, die: () => { dead = true; } };
}

function kill(first: { die: () => void }, disk: ReturnType<typeof deviceDisk>): void {
  first.die(); disk.kill(); vi.clearAllTimers(); vi.useRealTimers();
}

const TO = [{ name: null, address: "peer@fake.test" }];
const sends = (fake: ReturnType<typeof mailServer>) => fake.seen.filter((r) => r.method === "POST" && /^\/drafts\/[^/]+\/send$/.test(r.url));
const drafts = (fake: ReturnType<typeof mailServer>) => fake.draftRows().filter((r) => r.status !== "sent");
const onDisk = (disk: ReturnType<typeof deviceDisk>, like: string) => disk.names().reduce((n, f) => n + disk.rows(f, like), 0);

describe("a letter being written survives a hard stop", () => {
  it("typed words and a photo, half a second, a kill: the next launch keeps ONE draft, the photo with it, nothing sent", async () => {
    const { fake, origin } = await server();
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin);
      holdTheClock();
      const letter = first.compose();
      letter.addFile({ filename: "beach.jpg", contentType: "image/jpeg", contentBase64: PHOTO, sizeBytes: 2048 });
      letter.edit({ ...WORDS, body: "Half a thought, and more" });
      vi.advanceTimersByTime(500);
      expect(await first.letters.landed()).toBe("stored");
      kill(first, disk);

      const next = await launch(disk, origin);
      const r = await next.restore();
      expect(r.kept).toBe(1);
      expect(drafts(fake), "the letter was not kept as one draft").toHaveLength(1);
      const row = drafts(fake)[0]!;
      expect(row).toMatchObject({ subject: "Plans", body: "Half a thought, and more", to: [{ name: null, address: "peer@fake.test" }] });
      expect(next.letters.filesOf(String(row.id)).map((f) => [f.filename, f.contentBase64])).toEqual([["beach.jpg", PHOTO]]);
      expect(sends(fake), "a restore sent something").toHaveLength(0);
      expect(next.said).toEqual([sayArg(refuse("lettersKept", 1))]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("a kill right after the app left the foreground keeps what was typed since the last write", async () => {
    const { fake, origin } = await server();
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin);
      holdTheClock();
      const letter = first.compose();
      letter.edit({ ...WORDS, body: "Typed before the home button" });
      letter.flush();
      expect(await first.letters.landed()).toBe("stored");
      kill(first, disk);

      const next = await launch(disk, origin);
      await next.restore();
      expect(drafts(fake).map((d) => d.body)).toEqual(["Typed before the home button"]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("a kill between the keep's outbox row and its bind leaves ONE row, bound at the next launch", async () => {
    const { fake, origin } = await server();
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin);
      holdTheClock();
      const letter = first.compose();
      letter.addFile({ filename: "plan.pdf", contentType: "application/pdf", contentBase64: PHOTO, sizeBytes: 2048 });
      letter.edit(WORDS);
      letter.flush();
      await first.letters.landed();
      disk.slow();
      letter.markKeep();
      void first.actions.draftKeep({
        mode: "new", messageId: null, mailboxId: "mb-1", to: [{ name: null, address: "peer@fake.test" }],
        subject: WORDS.subject, body: WORDS.body, files: 1, row: (r) => letter.keepAnswered(r),
      });
      for (let i = 0; i < 400 && onDisk(disk, "outbox_entry:%") === 0; i++) { disk.step(); await settle(5); }
      expect(onDisk(disk, "outbox_entry:%"), "the keep never reached the outbox").toBeGreaterThan(0);
      disk.step();
      await settle(5);
      kill(first, disk);

      const next = await launch(disk, origin);
      expect(next.engine.pendingMutations().map((p) => p.mutation.kind), "the keep's outbox row was not restored").toEqual(["draft_save"]);
      await next.restore();
      await next.flush();
      expect(drafts(fake), "the keep made two rows").toHaveLength(1);
      expect(next.letters.filesOf(String(drafts(fake)[0]!.id)).map((f) => f.filename)).toEqual(["plan.pdf"]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("an offline Send, a kill: no draft, the restored send goes once, the files go once it confirms", async () => {
    const { fake, origin } = await server();
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin, { offline: true });
      holdTheClock();
      const letter = first.compose();
      const file = { filename: "beach.jpg", contentType: "image/jpeg", contentBase64: PHOTO };
      letter.addFile({ ...file, sizeBytes: 2048 });
      letter.edit(WORDS);
      const res = await letter.sendVia(() => first.actions.sendNew("mb-1", TO, WORDS.subject, WORDS.body, null, null, [file]));
      expect(res.outcome).toBe("queued");
      await first.letters.landed();
      kill(first, disk);

      const next = await launch(disk, origin);
      const r = await next.restore();
      expect(r).toEqual({ kept: 0, unclear: 0, unconfirmed: 0, changed: 0, notKept: [] });
      await next.flush();
      expect(sends(fake), "the restored send went other than once").toHaveLength(1);
      expect(drafts(fake), "a restore kept a sent letter as a draft").toHaveLength(0);
      expect(next.letters.letters()).toEqual([]);
      await next.letters.landed();
      expect(onDisk(disk, "compose_file:%"), "the files outlived the confirmed send").toBe(0);
    } finally { fake.server.close(); }
  }, 60_000);

  it("a Send killed once its outbox row is on the disk: the letter was marked first, so no draft, and it goes once", async () => {
    const { fake, origin } = await server();
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin, { offline: true });
      holdTheClock();
      const letter = first.compose();
      const file = { filename: "beach.jpg", contentType: "image/jpeg", contentBase64: PHOTO };
      letter.addFile({ ...file, sizeBytes: 2048 });
      letter.edit(WORDS);
      letter.flush();
      await first.letters.landed();
      disk.slow();
      void letter.sendVia(() => first.actions.sendNew("mb-1", TO, WORDS.subject, WORDS.body, null, null, [file]));
      for (let i = 0; i < 400 && onDisk(disk, "outbox_entry:%") === 0; i++) { disk.step(); await settle(5); }
      expect(onDisk(disk, "outbox_entry:%"), "the send never reached the outbox").toBeGreaterThan(0);
      // Its transaction's COMMIT, the next statement on the lane: the row is durable.
      disk.step();
      await settle(5);
      kill(first, disk);

      const next = await launch(disk, origin);
      const r = await next.restore();
      await next.flush();
      expect(r.kept, "a letter whose send was on its way was kept as a draft").toBe(0);
      expect(drafts(fake)).toHaveLength(0);
      expect(sends(fake)).toHaveLength(1);
      expect(next.letters.letters()).toEqual([]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("a Send killed before its outbox row was durable: a draft with the caution to check Sent, and nothing sent", async () => {
    const { fake, origin } = await server();
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin, { offline: true });
      holdTheClock();
      const letter = first.compose();
      letter.edit(WORDS);
      letter.flush();
      await first.letters.landed();
      disk.slow();
      void letter.sendVia(() => first.actions.sendNew("mb-1", TO, WORDS.subject, WORDS.body));
      // The row is written inside its transaction, and the kill rolls the transaction back.
      for (let i = 0; i < 400 && onDisk(disk, "outbox_entry:%") === 0; i++) { disk.step(); await settle(5); }
      kill(first, disk);

      const next = await launch(disk, origin);
      const r = await next.restore();
      await next.flush();
      expect(r.unclear).toBe(1);
      expect(drafts(fake).map((d) => d.body)).toEqual([WORDS.body]);
      expect(sends(fake), "a restore sent a letter it could not prove unsent").toHaveLength(0);
      expect(next.said).toEqual([sayArg(refuse("letterSendUnclear", 1))]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("a Send killed before its outbox row, beside an older sent mail of the same subject: the letter is kept, never dropped", async () => {
    const { fake, origin } = await server();
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin, { offline: true });
      fake.addDraft({
        id: "d-old", mailboxId: "mb-1", subject: "Invoice", body: "Attached is the September invoice.", to: TO, cc: [], bcc: [],
        status: "sent", updatedAt: "2026-09-24T08:00:00.000Z",
      });
      await first.engine.syncOnce().catch(() => undefined);
      holdTheClock();
      const words = { ...WORDS, subject: "Invoice", body: "" };
      const letter = first.compose({ words });
      const file = { filename: "invoice-october.pdf", contentType: "application/pdf", contentBase64: PHOTO };
      letter.addFile({ ...file, sizeBytes: 2048 });
      letter.edit(words);
      letter.flush();
      await first.letters.landed();
      disk.slow();
      void letter.sendVia(() => first.actions.sendNew("mb-1", TO, "Invoice", "", null, null, [file]));
      for (let i = 0; i < 400 && onDisk(disk, "outbox_entry:%") === 0; i++) { disk.step(); await settle(5); }
      kill(first, disk);

      const next = await launch(disk, origin);
      const r = await next.restore();
      await next.flush();
      expect(r.unclear).toBe(1);
      expect(drafts(fake).map((d) => d.subject), "the unsent letter was dropped as the older sent mail").toEqual(["Invoice"]);
      expect(next.letters.filesOf(String(drafts(fake)[0]!.id)).map((f) => f.filename)).toEqual(["invoice-october.pdf"]);
      expect(sends(fake)).toHaveLength(0);
      expect(next.said).toEqual([sayArg(refuse("letterSendUnclear", 1))]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("a send answered unverified, its sheet closed, an ordinary relaunch: one row, the held one, its photo with it, nothing said", async () => {
    const { fake, origin } = await server();
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin);
      holdTheClock();
      const letter = first.compose();
      const file = { filename: "beach.jpg", contentType: "image/jpeg", contentBase64: PHOTO };
      letter.addFile({ ...file, sizeBytes: 2048 });
      letter.edit(WORDS);
      fake.unverifiedNextSend();
      const res = await letter.sendVia(() => first.actions.sendNew("mb-1", TO, WORDS.subject, WORDS.body, null, null, [file]));
      expect(res).toMatchObject({ outcome: "unverified", draftId: "d-1" });
      // The server holds the row it sent from as `unverified`.
      fake.addDraft({ ...fake.draft("d-1")!, id: "d-1", status: "unverified", updatedAt: new Date().toISOString() });
      // The locked sheet closes over it: the letter stays for whoever settles it.
      letter.release();
      await first.letters.landed();
      expect(first.letters.letters().map((l) => [l.draftId, l.send]), "the answer left the letter unbound").toEqual([["d-1", null]]);
      kill(first, disk);

      const next = await launch(disk, origin);
      const r = await next.restore();
      await next.letters.landed();
      expect(r).toEqual({ kept: 0, unclear: 0, unconfirmed: 0, changed: 0, notKept: [] });
      expect(fake.draftRows().map((d) => d.id), "a second draft beside the held send").toEqual(["d-1"]);
      expect(next.letters.filesOf("d-1").map((f) => f.filename)).toEqual(["beach.jpg"]);
      expect(next.said).toEqual([]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("a queued send whose flush answers unverified after its sheet closed: one row at the next launch, its photo with it", async () => {
    const { fake, origin } = await server();
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin, { offline: true });
      holdTheClock();
      const letter = first.compose();
      const file = { filename: "beach.jpg", contentType: "image/jpeg", contentBase64: PHOTO };
      letter.addFile({ ...file, sizeBytes: 2048 });
      letter.edit(WORDS);
      const res = await letter.sendVia(() => first.actions.sendNew("mb-1", TO, WORDS.subject, WORDS.body, null, null, [file]));
      expect(res.outcome).toBe("queued");
      first.actions.leaveSend(res.key!);
      letter.release();
      first.net.offline = false;
      fake.unverifiedNextSend();
      const settled = await first.flush();
      expect([...settled.values()].map((o) => [o.status, o.draftId])).toEqual([["unverified", "d-1"]]);
      expect(first.letters.filesOf("d-1").map((f) => f.filename), "the flush left the files off the held row").toEqual(["beach.jpg"]);
      fake.addDraft({ ...fake.draft("d-1")!, id: "d-1", status: "unverified", updatedAt: new Date().toISOString() });
      await first.letters.landed();
      kill(first, disk);

      const next = await launch(disk, origin);
      await next.restore();
      expect(fake.draftRows().map((d) => d.id)).toEqual(["d-1"]);
      expect(next.letters.filesOf("d-1").map((f) => f.filename)).toEqual(["beach.jpg"]);
      expect(next.said).toEqual([]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("a kill after the server answered unverified, before the answer was written: the restore binds the held row", async () => {
    const { fake, origin } = await server();
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin);
      holdTheClock();
      const letter = first.compose();
      const file = { filename: "beach.jpg", contentType: "image/jpeg", contentBase64: PHOTO };
      letter.addFile({ ...file, sizeBytes: 2048 });
      letter.edit(WORDS);
      letter.markSend();
      await first.letters.landed();
      fake.unverifiedNextSend();
      await first.actions.sendNew("mb-1", TO, WORDS.subject, WORDS.body, null, null, [file]);
      fake.addDraft({ ...fake.draft("d-1")!, id: "d-1", status: "unverified", updatedAt: new Date().toISOString() });
      kill(first, disk);

      const next = await launch(disk, origin);
      const r = await next.restore();
      expect(r.kept + r.unclear + r.unconfirmed).toBe(0);
      expect(fake.draftRows().map((d) => d.id)).toEqual(["d-1"]);
      expect(next.letters.filesOf("d-1").map((f) => f.filename)).toEqual(["beach.jpg"]);
      expect(next.said).toEqual([]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("a draft opened from Drafts, edited, killed: its row holds the newest words, its file still on the phone", async () => {
    const { fake, origin } = await server();
    fake.addDraft({ id: "d-9", mailboxId: "mb-1", subject: "Plans", body: "First words", to: [{ name: null, address: "peer@fake.test" }], cc: [], bcc: [], status: "draft" });
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin);
      await first.engine.syncOnce();
      holdTheClock();
      const savedAs = JSON.stringify(["peer@fake.test", "Plans", "First words", "", ""]);
      const letter = first.compose({ draftId: "d-9", savedAs, words: { ...WORDS, body: "First words" } });
      letter.addFile({ filename: "plan.pdf", contentType: "application/pdf", contentBase64: PHOTO, sizeBytes: 2048 });
      letter.edit({ ...WORDS, body: "Newest words" });
      vi.advanceTimersByTime(500);
      await first.letters.landed();
      kill(first, disk);

      const next = await launch(disk, origin);
      await next.restore();
      expect(fake.draft("d-9")?.body).toBe("Newest words");
      expect(fake.draftRows()).toHaveLength(1);
      expect(next.letters.filesOf("d-9").map((f) => f.filename)).toEqual(["plan.pdf"]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("a second launch after the restore restores nothing and says nothing", async () => {
    const { fake, origin } = await server();
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin);
      holdTheClock();
      const letter = first.compose();
      letter.addFile({ filename: "beach.jpg", contentType: "image/jpeg", contentBase64: PHOTO, sizeBytes: 2048 });
      letter.edit(WORDS);
      letter.flush();
      await first.letters.landed();
      kill(first, disk);
      const second = await launch(disk, origin);
      await second.restore();
      await second.letters.landed();
      kill(second, disk);

      const third = await launch(disk, origin);
      const r = await third.restore();
      expect(r.kept).toBe(0);
      expect(third.said).toEqual([]);
      expect(fake.seen.filter((x) => x.method === "POST" && x.url === "/drafts")).toHaveLength(1);
      expect(third.letters.filesOf(String(drafts(fake)[0]!.id))).toHaveLength(1);
    } finally { fake.server.close(); }
  }, 60_000);

  /* A FORWARD WITH FILES REMOVED holds a choice its draft row cannot: the letter stays with the row. */
  const FWD: LetterWords = { ...WORDS, mode: "forward", messageId: "m1", subject: "Fwd: Welcome", body: "See below" };
  const forwardTo = (first: Awaited<ReturnType<typeof launch>>, parts: string[]) =>
    first.actions.sendForward("m1", TO, FWD.body, null, [], false, false, null, { forwardParts: parts });

  it("a forward's removed files outlive a keep, a refused send and an unverified one: each letter stays with its row", async () => {
    const { fake, origin } = await server();
    fake.setHello({ forwardParts: true });
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin);
      await first.engine.syncOnce();
      holdTheClock();
      const kept = first.compose({ words: FWD });
      kept.forwardKept(["att-1"]);
      kept.markKeep();
      await first.actions.draftKeep({
        mode: "forward", messageId: "m1", mailboxId: "mb-1", to: TO, subject: FWD.subject, body: FWD.body, files: 0,
        forwardParts: ["att-1"], row: (r) => kept.keepAnswered(r),
      });
      const keptRow = kept.current().draftId!;
      expect(first.letters.letterOf(keptRow)?.forwardKept, "the keep dropped the choice").toEqual(["att-1"]);
      expect(fake.draft(keptRow)?.forwardParts, "the row does not hold the kept files").toEqual(["att-1"]);

      const refused = first.compose({ words: FWD });
      refused.forwardKept(["att-2"]);
      refused.sendAnswered({ outcome: "failed", draftId: "d-refused" });
      expect(first.letters.letterOf("d-refused")?.forwardKept, "the refusal dropped the choice").toEqual(["att-2"]);

      const held = first.compose({ words: FWD });
      held.forwardKept(["att-3"]);
      fake.unverifiedNextSend();
      const res = await held.sendVia(() => forwardTo(first, ["att-3"]));
      expect(res.outcome).toBe("unverified");
      expect(first.letters.letterOf(res.draftId!)?.forwardKept, "the unverified answer dropped the choice").toEqual(["att-3"]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("a forward's removed files outlive a kill: the restore keeps the draft and the flush its unverified send, the choice with each", async () => {
    const { fake, origin } = await server();
    fake.setHello({ forwardParts: true });
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin, { offline: true });
      await first.engine.syncOnce();
      holdTheClock();
      const queued = first.compose({ words: FWD });
      queued.forwardKept(["att-1"]);
      const res = await queued.sendVia(() => forwardTo(first, ["att-1"]));
      expect(res.outcome).toBe("queued");
      first.actions.leaveSend(res.key!);
      queued.release();
      first.net.offline = false;
      fake.unverifiedNextSend();
      const settled = await first.flush();
      const sentFrom = [...settled.values()][0]!.draftId!;
      expect(first.letters.letterOf(sentFrom)?.forwardKept, "the flush dropped the choice").toEqual(["att-1"]);
      const typed = first.compose({ words: { ...FWD, body: "Typed before the kill" } });
      typed.forwardKept(["att-2"]);
      typed.flush();
      await first.letters.landed();
      kill(first, disk);

      const next = await launch(disk, origin);
      await next.restore();
      await next.letters.landed();
      const row = drafts(fake).find((d) => d.body === "Typed before the kill")!;
      expect(next.letters.letterOf(String(row.id))?.forwardKept, "the restore dropped the choice").toEqual(["att-2"]);
      expect(row.forwardParts, "the restored row does not hold the kept files").toEqual(["att-2"]);
      expect(next.letters.letterOf(sentFrom)?.forwardKept).toEqual(["att-1"]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("a waiting send refused over a row changed on another device, its sheet closed: its words become a new draft, and the next launch leaves the other version alone", async () => {
    const { fake, origin } = await server();
    fake.addDraft({
      id: "d-9", mailboxId: "mb-1", threadId: null, inReplyToMessageId: null, subject: "Plans", body: "Half a thought", to: TO, cc: [], bcc: [],
      rationale: null, status: "draft", createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-20T14:29:00.000Z", contentRevision: "rev-0",
    } as unknown as Record<string, unknown> & { id: string });
    const revisionOf = (id: string) => (fake.draft(id) as { contentRevision?: string } | undefined)?.contentRevision;
    const PHONE = "Half a thought, and the phone's closing line";
    const DESKTOP = "Rewritten on the desktop";
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin, { revisionOf });
      await first.engine.syncOnce();
      const letter = first.compose({ draftId: "d-9", savedAs: wordsOf(WORDS) });
      letter.edit({ ...WORDS, body: PHONE });
      letter.flush();
      first.net.offline = true;
      const res = await letter.sendVia(() => first.actions.sendNew("mb-1", TO, "Plans", PHONE, null, null, [], "d-9", { cc: [], bcc: [] }, "rev-0"));
      expect(res.outcome, "the send did not wait").toBe("queued");
      letter.release();
      const put = await globalThis.fetch(`${origin}/drafts/d-9`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "Plans", body: DESKTOP, to: TO, cc: [], bcc: [], ifContentRevision: revisionOf("d-9") }),
      });
      expect(put.status).toBe(200);
      first.net.offline = false;
      await first.flush();
      expect({ theirs: fake.draft("d-9")?.body, mine: drafts(fake).filter((r) => r.body === PHONE).length, sent: fake.deliveries().length, said: first.said.at(-1) })
        .toEqual({ theirs: DESKTOP, mine: 1, sent: 0, said: sayArg(refuse("replyChangedElsewhere")) });
      expect(await first.letters.landed()).toBe("stored");
      kill(first, disk);

      const next = await launch(disk, origin, { revisionOf });
      await next.restore();
      expect({ theirs: fake.draft("d-9")?.body, rows: drafts(fake).length }).toEqual({ theirs: DESKTOP, rows: 2 });
    } finally { fake.server.close(); }
  }, 60_000);

  describe("a kept letter over a row another device changed since", () => {
    const OPENED: LetterWords = { ...WORDS, body: "First words" };
    const DESKTOP = "Rewritten on the desktop";
    const atRev0 = (fake: ReturnType<typeof mailServer>) => fake.addDraft({
      id: "d-9", mailboxId: "mb-1", threadId: null, inReplyToMessageId: null, subject: "Plans", body: "First words", to: TO, cc: [], bcc: [],
      rationale: null, status: "draft", createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-20T14:29:00.000Z", contentRevision: "rev-0",
    } as unknown as Record<string, unknown> & { id: string });
    const versionOf = (fake: ReturnType<typeof mailServer>) => (id: string) => (fake.draft(id) as { contentRevision?: string } | undefined)?.contentRevision;
    /** The desktop saves d-9 over the version it read. */
    const rewrite = (origin: string, body: string, rev: string) => globalThis.fetch(`${origin}/drafts/d-9`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "Plans", body, to: TO, cc: [], bcc: [], ifContentRevision: rev }),
    });

    it("opened at rev-0, a file added, typed, killed; the desktop saved it since: the restore keeps both versions, the file with the phone's, one sentence", async () => {
      const { fake, origin } = await server();
      atRev0(fake);
      const disk = deviceDisk();
      try {
        const first = await launch(disk, origin, { revisionOf: versionOf(fake) });
        await first.engine.syncOnce();
        holdTheClock();
        const letter = first.compose({ draftId: "d-9", savedAs: wordsOf(OPENED), revision: "rev-0", words: OPENED });
        letter.addFile({ filename: "plan.pdf", contentType: "application/pdf", contentBase64: PHOTO, sizeBytes: 2048 });
        letter.edit({ ...WORDS, body: "Typed on the phone" });
        vi.advanceTimersByTime(500);
        await first.letters.landed();
        kill(first, disk);
        expect((await rewrite(origin, DESKTOP, "rev-0")).status).toBe(200);

        const next = await launch(disk, origin, { revisionOf: versionOf(fake) });
        await next.restore();
        await next.letters.landed();
        const mine = drafts(fake).find((d) => d.id !== "d-9");
        expect({ theirs: fake.draft("d-9")?.body, mine: mine?.body, rows: drafts(fake).length, sent: sends(fake).length })
          .toEqual({ theirs: DESKTOP, mine: "Typed on the phone", rows: 2, sent: 0 });
        expect(next.letters.filesOf(String(mine?.id)).map((f) => f.filename), "the file did not follow the phone's words").toEqual(["plan.pdf"]);
        expect(next.letters.filesOf("d-9"), "the phone's file stayed on the desktop's version").toEqual([]);
        expect(next.said).toEqual([sayArg(refuse("lettersKeptChangedElsewhere", 1))]);
      } finally { fake.server.close(); }
    }, 60_000);

    it("Send pressed at rev-0 and killed before its outbox row; the desktop saved it since: both versions kept, nothing sent, the caution said", async () => {
      const { fake, origin } = await server();
      atRev0(fake);
      const disk = deviceDisk();
      try {
        const first = await launch(disk, origin, { revisionOf: versionOf(fake) });
        await first.engine.syncOnce();
        holdTheClock();
        const letter = first.compose({ draftId: "d-9", savedAs: wordsOf(OPENED), revision: "rev-0", words: OPENED });
        letter.edit({ ...WORDS, body: "Sent from the phone" });
        letter.markSend();
        await first.letters.landed();
        kill(first, disk);
        expect((await rewrite(origin, DESKTOP, "rev-0")).status).toBe(200);

        const next = await launch(disk, origin, { revisionOf: versionOf(fake) });
        await next.restore();
        const mine = drafts(fake).find((d) => d.id !== "d-9");
        expect({ theirs: fake.draft("d-9")?.body, mine: mine?.body, sent: sends(fake).length, said: next.said })
          .toEqual({ theirs: DESKTOP, mine: "Sent from the phone", sent: 0, said: [sayArg(refuse("letterSendUnclear", 1))] });
      } finally { fake.server.close(); }
    }, 60_000);

    it("a confirmed save on the phone moved the row's version, typed on, killed: the restore writes in place", async () => {
      const { fake, origin } = await server();
      atRev0(fake);
      const disk = deviceDisk();
      try {
        const first = await launch(disk, origin, { revisionOf: versionOf(fake) });
        await first.engine.syncOnce();
        holdTheClock();
        const letter = first.compose({ draftId: "d-9", savedAs: wordsOf(OPENED), revision: "rev-0", words: OPENED });
        letter.addFile({ filename: "plan.pdf", contentType: "application/pdf", contentBase64: PHOTO, sizeBytes: 2048 });
        const saved = { ...WORDS, body: "Saved from the phone" };
        letter.edit(saved);
        let rev: string | undefined;
        expect(await first.actions.draftKeep({
          mode: "new", messageId: null, mailboxId: "mb-1", to: TO, subject: "Plans", body: saved.body, files: 0, draftId: "d-9", revision: "rev-0", quiet: true,
          row: (r) => { rev = r.revision; },
        })).toBe("kept");
        letter.saved("d-9", wordsOf(saved), rev ?? null);
        letter.edit({ ...WORDS, body: "Typed after the save" });
        vi.advanceTimersByTime(500);
        await first.letters.landed();
        kill(first, disk);

        const next = await launch(disk, origin, { revisionOf: versionOf(fake) });
        await next.restore();
        expect({ body: fake.draft("d-9")?.body, rows: drafts(fake).length }).toEqual({ body: "Typed after the save", rows: 1 });
      } finally { fake.server.close(); }
    }, 60_000);

    it("a kept letter with a file, its row saved elsewhere, reopened from Drafts and typed on, killed: the restore writes in place", async () => {
      const { fake, origin } = await server();
      atRev0(fake);
      const disk = deviceDisk();
      try {
        const first = await launch(disk, origin, { revisionOf: versionOf(fake) });
        await first.engine.syncOnce();
        holdTheClock();
        const kept = first.compose({ draftId: "d-9", savedAs: wordsOf(OPENED), revision: "rev-0", words: OPENED });
        kept.addFile({ filename: "plan.pdf", contentType: "application/pdf", contentBase64: PHOTO, sizeBytes: 2048 });
        kept.markKeep();
        kept.keepAnswered({ draftId: "d-9", key: null, revision: "rev-0" });
        kept.release();
        expect((await rewrite(origin, DESKTOP, "rev-0")).status).toBe(200);
        await first.engine.syncOnce();
        const theirs = { ...WORDS, body: DESKTOP };
        const reopened = first.compose({
          id: first.letters.letterOf("d-9")!.id, draftId: "d-9", savedAs: wordsOf(theirs), revision: versionOf(fake)("d-9"), words: theirs,
        });
        reopened.edit({ ...WORDS, body: `${DESKTOP}, and the phone's line` });
        vi.advanceTimersByTime(500);
        await first.letters.landed();
        kill(first, disk);

        const next = await launch(disk, origin, { revisionOf: versionOf(fake) });
        await next.restore();
        expect({ body: fake.draft("d-9")?.body, rows: drafts(fake).length }).toEqual({ body: `${DESKTOP}, and the phone's line`, rows: 1 });
      } finally { fake.server.close(); }
    }, 60_000);

    const save = (first: Awaited<ReturnType<typeof launch>>, body: string) => first.actions.draftKeep({
      mode: "new", messageId: null, mailboxId: "mb-1", to: TO, subject: "Plans", body, files: 0, draftId: "d-9", revision: "rev-0", quiet: true, row: () => undefined,
    });

    it("an autosave queued offline lands on the reconnect, typed on, killed: the restore writes in place, nothing said of another device", async () => {
      const { fake, origin } = await server();
      atRev0(fake);
      const disk = deviceDisk();
      try {
        const first = await launch(disk, origin, { revisionOf: versionOf(fake) });
        await first.engine.syncOnce();
        holdTheClock();
        const letter = first.compose({ draftId: "d-9", savedAs: wordsOf(OPENED), revision: "rev-0", words: OPENED });
        const queued = { ...WORDS, body: "Typed in the tunnel" };
        letter.edit(queued);
        first.net.cut = true;
        await save(first, queued.body);
        // A queued save keeps its base: the sheet tells the keeper the version it opened.
        letter.saved("d-9", wordsOf(queued), "rev-0");
        first.net.cut = false;
        await first.flush();
        expect(versionOf(fake)("d-9"), "the phone's own save did not land").not.toBe("rev-0");
        letter.edit({ ...WORDS, body: "Typed in the tunnel, and after it" });
        vi.advanceTimersByTime(500);
        await first.letters.landed();
        kill(first, disk);

        const next = await launch(disk, origin, { revisionOf: versionOf(fake) });
        await next.restore();
        expect({ body: fake.draft("d-9")?.body, rows: drafts(fake).length, said: next.said })
          .toEqual({ body: "Typed in the tunnel, and after it", rows: 1, said: [sayArg(refuse("lettersKept", 1))] });
      } finally { fake.server.close(); }
    }, 60_000);

    it("an autosave the server wrote but whose answer the kill swallowed, typed on meanwhile: the next launch writes in place", async () => {
      const { fake, origin } = await server();
      atRev0(fake);
      const disk = deviceDisk();
      try {
        const first = await launch(disk, origin, { revisionOf: versionOf(fake) });
        await first.engine.syncOnce();
        const letter = first.compose({ draftId: "d-9", savedAs: wordsOf(OPENED), revision: "rev-0", words: OPENED });
        const unanswered = "Typed on the phone";
        letter.edit({ ...WORDS, body: unanswered });
        letter.flush();
        first.net.swallow = true;
        void save(first, unanswered);
        for (let i = 0; i < 200 && fake.draft("d-9")?.body !== unanswered; i++) await new Promise((r) => setTimeout(r, 10));
        expect(fake.draft("d-9")?.body, "the swallowed save never reached the origin").toBe(unanswered);
        letter.edit({ ...WORDS, body: "Typed on the phone, and more while it saved" });
        letter.flush();
        await first.letters.landed();
        kill(first, disk);

        // world.tsx starts the restore before the reconnect flush.
        const next = await launch(disk, origin, { revisionOf: versionOf(fake) });
        const restored = next.restore();
        await Promise.race([restored, next.waitsOnFlush]);
        await next.flush();
        await restored;
        expect({ body: fake.draft("d-9")?.body, rows: drafts(fake).length, said: next.said })
          .toEqual({ body: "Typed on the phone, and more while it saved", rows: 1, said: [sayArg(refuse("lettersKept", 1))] });
      } finally { fake.server.close(); }
    }, 60_000);

    /** The sheet's quiet save of d-9, as MessageActions drives it: `letter.saved` once kept. */
    const sheetSave = async (
      first: Awaited<ReturnType<typeof launch>>, letter: ReturnType<Awaited<ReturnType<typeof launch>>["compose"]>,
      base: { current: DraftBase }, body: string,
    ) => {
      let row = "d-9";
      const answer = await first.actions.draftKeep({
        mode: "new", messageId: null, mailboxId: "mb-1", to: TO, cc: [], bcc: [], subject: "Plans", body, files: 0, draftId: "d-9", quiet: true,
        revision: baseFor(base.current, "d-9"), waited: waitedFor(base.current, "d-9"), forked: () => undefined, rebind: () => undefined,
        row: (r) => { if (r.draftId !== null) row = r.draftId; base.current = baseAfter(base.current, r); },
      });
      if (answer === "kept") letter.saved(row, wordsOf({ ...WORDS, body }), baseFor(base.current, row));
      return answer;
    };
    /** Opened from Drafts at rev-0, typed offline, the sheet's save queued; `then` runs before the kill. */
    const queuedThenKilled = async (
      fake: ReturnType<typeof mailServer>, origin: string, disk: ReturnType<typeof deviceDisk>,
      then: (letter: ReturnType<Awaited<ReturnType<typeof launch>>["compose"]>) => void = () => undefined,
    ) => {
      const first = await launch(disk, origin, { revisionOf: versionOf(fake) });
      await first.engine.syncOnce();
      holdTheClock();
      const letter = first.compose({ draftId: "d-9", savedAs: wordsOf(OPENED), revision: "rev-0", words: OPENED });
      then(letter);
      letter.edit({ ...WORDS, body: "Typed offline" });
      vi.advanceTimersByTime(500);
      first.net.cut = true;
      expect(await sheetSave(first, letter, { current: { row: "d-9", rev: "rev-0" } }, "Typed offline")).toBe("kept");
      return { first, letter };
    };
    /** `world.tsx`'s launch: the restore starts, the reconnect flush runs, the restore ends. */
    const relaunch = async (disk: ReturnType<typeof deviceDisk>, origin: string, fake: ReturnType<typeof mailServer>) => {
      const next = await launch(disk, origin, { revisionOf: versionOf(fake) });
      const restored = next.restore();
      await Promise.race([restored, next.waitsOnFlush]);
      await next.flush();
      await restored;
      await next.letters.landed();
      return next;
    };

    it("an autosave queued offline, killed, the desktop saved it since: the phone's words are a new draft, said as kept, never as failed", async () => {
      const { fake, origin } = await server();
      atRev0(fake);
      const disk = deviceDisk();
      try {
        const { first } = await queuedThenKilled(fake, origin, disk);
        await first.letters.landed();
        kill(first, disk);
        expect((await rewrite(origin, DESKTOP, "rev-0")).status).toBe(200);

        const next = await relaunch(disk, origin, fake);
        const mine = drafts(fake).find((d) => d.id !== "d-9");
        expect({ theirs: fake.draft("d-9")?.body, mine: mine?.body, rows: drafts(fake).length, sent: sends(fake).length, said: next.said })
          .toEqual({ theirs: DESKTOP, mine: "Typed offline", rows: 2, sent: 0, said: [sayArg(refuse("lettersKeptChangedElsewhere", 1))] });
        expect(next.letters.letters()).toEqual([]);
      } finally { fake.server.close(); }
    }, 60_000);

    it("the same with a file: the file goes with the phone's words, not with the desktop's version", async () => {
      const { fake, origin } = await server();
      atRev0(fake);
      const disk = deviceDisk();
      try {
        const { first } = await queuedThenKilled(fake, origin, disk, (letter) => {
          letter.addFile({ filename: "plan.pdf", contentType: "application/pdf", contentBase64: PHOTO, sizeBytes: 2048 });
        });
        await first.letters.landed();
        kill(first, disk);
        expect((await rewrite(origin, DESKTOP, "rev-0")).status).toBe(200);

        const next = await relaunch(disk, origin, fake);
        const mine = drafts(fake).find((d) => d.id !== "d-9");
        expect(next.letters.filesOf(String(mine?.id)).map((f) => f.filename), "the file did not follow the phone's words").toEqual(["plan.pdf"]);
        expect(next.letters.filesOf("d-9"), "the phone's file stayed on the desktop's version").toEqual([]);
        expect({ mine: mine?.body, rows: drafts(fake).length, said: next.said })
          .toEqual({ mine: "Typed offline", rows: 2, said: [sayArg(refuse("lettersKeptChangedElsewhere", 1))] });
      } finally { fake.server.close(); }
    }, 60_000);

    it("typed on after the queued autosave, killed, the desktop saved it since: one new draft with the newest words, one sentence", async () => {
      const { fake, origin } = await server();
      atRev0(fake);
      const disk = deviceDisk();
      try {
        const { first, letter } = await queuedThenKilled(fake, origin, disk);
        letter.edit({ ...WORDS, body: "Typed offline, and on" });
        vi.advanceTimersByTime(500);
        await first.letters.landed();
        kill(first, disk);
        expect((await rewrite(origin, DESKTOP, "rev-0")).status).toBe(200);

        const next = await relaunch(disk, origin, fake);
        const mine = drafts(fake).find((d) => d.id !== "d-9");
        expect({ theirs: fake.draft("d-9")?.body, mine: mine?.body, rows: drafts(fake).length, sent: sends(fake).length, said: next.said })
          .toEqual({ theirs: DESKTOP, mine: "Typed offline, and on", rows: 2, sent: 0, said: [sayArg(refuse("lettersKeptChangedElsewhere", 1))] });
      } finally { fake.server.close(); }
    }, 60_000);

    it("the sheet still open, its autosave queued offline, the desktop saved it since: the reconnect says the words were kept", async () => {
      const { fake, origin } = await server();
      atRev0(fake);
      const disk = deviceDisk();
      try {
        const first = await launch(disk, origin, { revisionOf: versionOf(fake) });
        await first.engine.syncOnce();
        const letter = first.compose({ draftId: "d-9", savedAs: wordsOf(OPENED), revision: "rev-0", words: OPENED });
        letter.edit({ ...WORDS, body: "Typed offline" });
        first.net.cut = true;
        expect(await sheetSave(first, letter, { current: { row: "d-9", rev: "rev-0" } }, "Typed offline")).toBe("kept");
        expect((await rewrite(origin, DESKTOP, "rev-0")).status).toBe(200);
        first.net.cut = false;
        await first.flush();
        expect({ theirs: fake.draft("d-9")?.body, rows: drafts(fake).length, said: first.said })
          .toEqual({ theirs: DESKTOP, rows: 2, said: [sayArg(refuse("composeKeptChangedElsewhere"))] });
      } finally { fake.server.close(); }
    }, 60_000);

    it("an autosave queued offline, killed, nothing changed elsewhere: written in place, nothing said", async () => {
      const { fake, origin } = await server();
      atRev0(fake);
      const disk = deviceDisk();
      try {
        const { first } = await queuedThenKilled(fake, origin, disk);
        await first.letters.landed();
        kill(first, disk);

        const next = await relaunch(disk, origin, fake);
        expect({ body: fake.draft("d-9")?.body, rows: drafts(fake).length, said: next.said }).toEqual({ body: "Typed offline", rows: 1, said: [] });
      } finally { fake.server.close(); }
    }, 60_000);

    /** The relaunch on a slow link: the `method` request outlives the replay deadline, its answer read by the next flush. */
    const lateRelaunch = async (disk: ReturnType<typeof deviceDisk>, origin: string, fake: ReturnType<typeof mailServer>, method: string) => {
      const next = await launch(disk, origin, { revisionOf: versionOf(fake) });
      let release = (): void => undefined;
      next.net.held = { method, until: new Promise<void>((r) => { release = r; }) };
      const restored = next.restore();
      await Promise.race([restored, next.waitsOnFlush]);
      holdTheClock();
      const first = next.flush();
      await settle();
      vi.advanceTimersByTime(10_001);
      await first;
      vi.useRealTimers();
      release();
      for (let i = 0; i < 400 && !next.engine.hasLateResults(); i++) await settle(5);
      expect(next.engine.hasLateResults(), "no late answer").toBe(true);
      await next.flush();
      await restored;
      await next.letters.landed();
      return next;
    };

    it("the queued save answered past the replay deadline: still said as kept, and the file follows the phone's words", async () => {
      const { fake, origin } = await server();
      atRev0(fake);
      const disk = deviceDisk();
      try {
        const { first } = await queuedThenKilled(fake, origin, disk, (letter) => {
          letter.addFile({ filename: "plan.pdf", contentType: "application/pdf", contentBase64: PHOTO, sizeBytes: 2048 });
        });
        await first.letters.landed();
        kill(first, disk);
        expect((await rewrite(origin, DESKTOP, "rev-0")).status).toBe(200);

        const next = await lateRelaunch(disk, origin, fake, "PUT");
        const mine = drafts(fake).find((d) => d.id !== "d-9");
        expect({ mine: mine?.body, rows: drafts(fake).length, sent: sends(fake).length, said: next.said })
          .toEqual({ mine: "Typed offline", rows: 2, sent: 0, said: [sayArg(refuse("lettersKeptChangedElsewhere", 1))] });
        expect(next.letters.filesOf(String(mine?.id)).map((f) => f.filename)).toEqual(["plan.pdf"]);
        expect(next.letters.filesOf("d-9")).toEqual([]);
      } finally { fake.server.close(); }
    }, 60_000);

    it("the new draft's create answered past the replay deadline: still said as kept, and the file follows", async () => {
      const { fake, origin } = await server();
      atRev0(fake);
      const disk = deviceDisk();
      try {
        const { first } = await queuedThenKilled(fake, origin, disk, (letter) => {
          letter.addFile({ filename: "plan.pdf", contentType: "application/pdf", contentBase64: PHOTO, sizeBytes: 2048 });
        });
        await first.letters.landed();
        kill(first, disk);
        expect((await rewrite(origin, DESKTOP, "rev-0")).status).toBe(200);

        const next = await lateRelaunch(disk, origin, fake, "POST");
        const mine = drafts(fake).find((d) => d.id !== "d-9");
        expect({ mine: mine?.body, rows: drafts(fake).length, said: next.said })
          .toEqual({ mine: "Typed offline", rows: 2, said: [sayArg(refuse("lettersKeptChangedElsewhere", 1))] });
        expect(next.letters.filesOf(String(mine?.id)).map((f) => f.filename)).toEqual(["plan.pdf"]);
        expect(next.letters.filesOf("d-9")).toEqual([]);
      } finally { fake.server.close(); }
    }, 60_000);

    it("any other refused save or move is still said as failed, once each", async () => {
      const { sayFlushedSaves } = await import("../src/state/live");
      const o = { forward: false, fresh: false, sendAt: null, earlierWent: false, done: null };
      expect(sayFlushedSaves([
        ["k1", { ...o, status: "rolled_back", kind: "draft_save" }], ["k2", { ...o, status: "rolled_back", kind: "move" }],
        ["k3", { ...o, status: "rolled_back", kind: "mail_send" }], ["k4", { ...o, status: "confirmed", kind: "draft_save" }],
      ]).map(sayArg)).toEqual([sayArg(refuse("liveSaveFailed")), sayArg(refuse("liveSaveFailed"))]);
    });
  });
});
