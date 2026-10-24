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
async function launch(disk: ReturnType<typeof deviceDisk>, origin: string, opts: { offline?: boolean } = {}) {
  vi.resetModules();
  const { bootEngine } = await import("../src/engine/boot");
  const { serialSqlExecutor } = await import("../src/engine/sql-queue");
  const live = await import("../src/state/live");
  const keeping = await import("../src/compose/letter-keeper");
  const restoring = await import("../src/compose/letter-restore");
  const { letterDoor } = await import("../src/compose/letter-store");
  let dead = false;
  const net = { offline: opts.offline === true };
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    if (dead) return never();
    if (net.offline && init?.method === "POST") return Promise.reject(new TypeError("Network request failed"));
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
  /** `world.tsx`'s restore, as the session runs it. */
  const restore = async () => {
    const r = await restoring.restoreLetters({
      door: letters, owned: keeping.ownedLetters(),
      outbox: () => [...engine.pendingMutations(), ...engine.inFlightMutations()].map((p) => ({ key: p.key, mutation: p.mutation })),
      keep: (k) => actions.draftKeep(k),
      hasMessage: (id) => engine.read().get("message", id) !== undefined,
      drafts: () => engine.read().entries<Record<string, unknown>>("draft").map((e) => ({ ...e.entity, id: e.id })),
      firstSync: () => engine.syncOnce().then(() => undefined),
      parse: live.keptRecipients,
    });
    const say = restoring.sayLetterRestore(r);
    if (say !== null) toast(say);
    return r;
  };
  /** `world.tsx`'s reconnect flush, letters settled by key. */
  const flush = async () => {
    const settled = await live.flushQueued(engine, actions.releaseConfirmed);
    restoring.settleLetters(letters, keeping.ownedLetters(), settled);
    return settled;
  };
  /** The sheet, opened: its letter on this launch's disk. */
  const compose = (o: { draftId?: string; savedAs?: string; words?: LetterWords } = {}) => keeping.openLetterKeeper({
    door: letters, id: uuid(), newFileId: uuid, words: o.words ?? WORDS,
    ...(o.draftId ? { draftId: o.draftId, savedAs: o.savedAs ?? null } : {}),
  });
  return { engine, store: boot.store, actions, letters, said, restore, flush, compose, net, die: () => { dead = true; } };
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
      expect(r).toEqual({ kept: 0, unclear: 0, unconfirmed: 0, notKept: [] });
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
      expect(r).toEqual({ kept: 0, unclear: 0, unconfirmed: 0, notKept: [] });
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
        mode: "forward", messageId: "m1", mailboxId: "mb-1", to: TO, subject: FWD.subject, body: FWD.body, files: 0, row: (r) => kept.keepAnswered(r),
      });
      const keptRow = kept.current().draftId!;
      expect(first.letters.letterOf(keptRow)?.forwardKept, "the keep dropped the choice").toEqual(["att-1"]);

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
      expect(next.letters.letterOf(sentFrom)?.forwardKept).toEqual(["att-1"]);
    } finally { fake.server.close(); }
  }, 60_000);
});
