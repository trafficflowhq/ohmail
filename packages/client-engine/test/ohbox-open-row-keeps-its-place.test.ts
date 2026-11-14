import { describe, expect, it } from "vitest";
import {
  OhmailEngine,
  ohboxView,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";
import { threadedEngine } from "./fixtures/threaded-demo.js";

/**
 * THE ROW BEING READ KEEPS ITS PLACE IN "NEW" until the reader moves on (owner ruling 2026-09-18,
 * narrowed 2026-10-07). The read lands at the open as an OPEN READ; the row files at the top of
 * "Earlier" only when the reader moves on or answers it, and a read of any other row keeps arrival. Held once, in the engine: every surface names the open row through
 * `holdOpenRow` and reads the Ohbox through `ohboxView(reader, held)`. Only the OPEN row is held.
 */

async function demoEngine(): Promise<OhmailEngine> {
  const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
  await engine.start();
  return engine;
}

const ids = (list: readonly EngineMessage[]) => list.map((m) => m.id);
const box = (engine: OhmailEngine) => ohboxView(engine.read(), engine.openRowHeld());

describe("the open row, through the engine", () => {
  it("opening an unread New row keeps it in New at its place while open; moving on files it in Earlier", async () => {
    const engine = await demoEngine();
    expect(ids(box(engine).newForYou)).toEqual(["giulia", "petra", "ben"]);

    expect(engine.holdOpenRow("petra")).toBe(true);
    const res = await engine.mutate({ kind: "mark_seen", messageIds: ["petra"], unread: false, via: "glance" });
    expect(res.status).toBe("confirmed");

    const open = box(engine);
    // MUTATION WATCHED (mutation-control.sh): `m.unread || m.id === openHeld` in `ohboxView` cut to
    // `m.unread` reads ["giulia", "ben"] here — the row the reader is on leaves New under them.
    expect(ids(open.newForYou), "the saved read moved the open row").toEqual(["giulia", "petra", "ben"]);
    expect(open.newForYou[1]!.unread, "the row IS read; only its place is held").toBe(false);
    expect(ids(open.previouslySeen)).not.toContain("petra");

    engine.releaseOpenRow("petra");
    const after = box(engine);
    expect(ids(after.newForYou)).toEqual(["giulia", "ben"]);
    // The same order the selector gives with nothing held at all (both read the stamp).
    expect(ids(after.previouslySeen)).toEqual(ids(ohboxView(engine.read()).previouslySeen));
    expect(ids(after.previouslySeen)).toContain("petra");
  });

  it("an OLDER row opened, read and left takes the top of Earlier, not its arrival slot (owner 2026-10-07)", async () => {
    const engine = await demoEngine();
    // `ben` arrived before techcheck, glazecall and cinderlock: at arrival it would file fourth.
    expect(engine.holdOpenRow("ben")).toBe(true);
    await engine.mutate({ kind: "mark_seen", messageIds: ["ben"], unread: false, via: "glance" });
    engine.releaseOpenRow("ben");
    const earlier = ids(box(engine).previouslySeen);
    expect(earlier.slice(0, 4)).toEqual(["ben", "techcheck", "glazecall", "cinderlock"]);
  });

  it("the hold reaches every subscriber in the SAME snapshot as the read's paint", async () => {
    // The desktop's race: the paint published synchronously while the view's own
    // hold was a React update behind it, so one render saw the row read and nothing held.
    const engine = await demoEngine();
    const seen: boolean[] = [];
    engine.subscribe(() => { seen.push(ids(box(engine).newForYou).includes("petra")); });
    engine.holdOpenRow("petra");
    await engine.mutate({ kind: "mark_seen", messageIds: ["petra"], unread: false, via: "glance" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean), `a notify saw the open row outside New: ${JSON.stringify(seen)}`).toBe(true);
  });

  it("CONTROL: an unopened row read elsewhere still moves at once, at its arrival index — only the open row is held", async () => {
    const engine = await demoEngine();
    engine.holdOpenRow("petra");
    await engine.mutate({ kind: "mark_seen", messageIds: ["ben"], unread: false });
    const v = box(engine);
    expect(ids(v.newForYou)).toEqual(["giulia", "petra"]);
    expect(ids(v.previouslySeen)).toContain("ben");
    // Not an open read (another conversation is held): Earlier stays one arrival chronology.
    const at = (m: EngineMessage) => Date.parse(m.sortAt ?? m.date ?? "");
    expect(ids(v.previouslySeen)).toEqual(ids([...v.previouslySeen].sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : -1))));
  });

  it("opening a row that is already read holds nothing, and releases what was held", async () => {
    const engine = await demoEngine();
    const earlier = ids(box(engine).previouslySeen)[0]!;
    engine.holdOpenRow("giulia");
    expect(engine.holdOpenRow(earlier), "a read row has no place in New to keep").toBe(false);
    expect(engine.openRowHeld()).toBeNull();
    // A release for another row is not this row's release.
    engine.holdOpenRow("petra");
    engine.releaseOpenRow("ben");
    expect(engine.openRowHeld()).toBe("petra");
  });

  it("an explicit act still moves the held row: filed away, it leaves the Ohbox", async () => {
    const engine = await demoEngine();
    engine.holdOpenRow("petra");
    await engine.mutate({ kind: "mark_seen", messageIds: ["petra"], unread: false, via: "glance" });
    await engine.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" });
    const v = box(engine);
    expect(ids(v.newForYou)).not.toContain("petra");
    expect(ids(v.previouslySeen)).not.toContain("petra");
    expect(engine.openRowHeld(), "the act moved it; the hold is spent").toBeNull();
  });

  it("pinned while held, then released with Done: it files in Earlier, not back in New", async () => {
    const engine = await demoEngine();
    engine.holdOpenRow("petra");
    await engine.mutate({ kind: "mark_seen", messageIds: ["petra"], unread: false, via: "glance" });
    await engine.mutate({ kind: "triage_set", messageId: "petra", state: "resurfaced" as never });
    expect(ids(box(engine).resurfaced)).toContain("petra");
    await engine.mutate({ kind: "mark_seen", messageIds: ["petra"], unread: false });
    const v = box(engine);
    expect(ids(v.newForYou)).not.toContain("petra");
    expect(ids(v.previouslySeen)).toContain("petra");
  });

  it("an act that leaves the row in New keeps the hold — a tag is not moving on", async () => {
    const engine = await demoEngine();
    engine.holdOpenRow("petra");
    await engine.mutate({ kind: "mark_seen", messageIds: ["petra"], unread: false, via: "glance" });
    const tagged = await engine.mutate({ kind: "tag_assign", messageId: "petra", tagId: "tag-a", assigned: true, createName: "A" });
    expect(tagged.status).toBe("confirmed");
    expect(engine.openRowHeld()).toBe("petra");
    expect(ids(box(engine).newForYou)).toContain("petra");
  });
});

/** Open H the way every surface does: hold it, then save the read at once. */
async function openH(engine: OhmailEngine): Promise<void> {
  expect(engine.holdOpenRow("giulia")).toBe(true);
  await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false, via: "glance" });
  expect(ids(box(engine).newForYou), "the premise: H is held in New, read").toContain("giulia");
}

const reply = (to: string, extra: Partial<Extract<EngineMutation, { kind: "mail_send" }>> = {}): EngineMutation =>
  ({ kind: "mail_send", inReplyTo: to, body: "TOPPPENS!", ...extra });
const sentCopies = (list: readonly EngineMessage[]) => list.filter((m) => m.local === true);

describe("an answer files the held row (owner defect 2026-09-28)", () => {
  it("the reported sequence: open H, reply to one person, confirm: H and the copy are in Earlier on T", async () => {
    const { engine } = await threadedEngine();
    await openH(engine);
    const res = await engine.mutate(reply("giulia"));
    expect(res.status).toBe("confirmed");
    const v = box(engine);
    // MUTATION WATCHED: `this.openRow = null` cut from `endHoldAnswered` keeps H in New here.
    expect(engine.openRowHeld(), "the answer did not end the hold").toBeNull();
    expect(ids(v.newForYou)).not.toContain("giulia");
    expect(ids(v.newForYou), "the unrelated unread row is untouched").toContain("petra");
    const earlierT = v.previouslySeen.filter((m) => m.threadId === "T");
    expect(ids(earlierT)).toContain("giulia");
    expect(sentCopies(earlierT), "the Sent copy stands on T in Earlier").toHaveLength(1);
    expect(v.newForYou.filter((m) => m.threadId === "T"), "nothing of T is left in New").toHaveLength(0);
  });

  it("ONE snapshot: no notify shows H in New beside the copy in Earlier", async () => {
    const { engine } = await threadedEngine();
    await openH(engine);
    const frames: { heldInNew: boolean; copy: boolean }[] = [];
    const off = engine.subscribe(() => {
      const v = box(engine);
      frames.push({ heldInNew: ids(v.newForYou).includes("giulia"), copy: sentCopies(v.previouslySeen).length > 0 });
    });
    await engine.mutate(reply("giulia"));
    off();
    // MUTATIONS WATCHED: `painted || this.endHoldAnswered(…)`, and a second notify between the
    // paint and the release, each publish a frame with both true.
    const split = frames.filter((f) => f.heldInNew && f.copy);
    expect(split, `frames: ${JSON.stringify(frames)}`).toHaveLength(0);
    const first = frames.findIndex((f) => f.copy);
    expect(first, "the subscriber never saw the copy (a control that saw nothing)").toBeGreaterThanOrEqual(0);
    expect(frames[first]!.heldInNew, "the copy's first frame still held H in New").toBe(false);
  });

  it("a forward of the open message ends the hold", async () => {
    const { engine } = await threadedEngine();
    await openH(engine);
    const res = await engine.mutate({
      kind: "mail_send", inReplyTo: null, forwardOf: "giulia",
      to: [{ name: "Z", address: "z@example.test" }], body: "fyi",
    });
    expect(res.status).toBe("confirmed");
    expect(engine.openRowHeld()).toBeNull();
    expect(ids(box(engine).previouslySeen)).toContain("giulia");
  });

  it("a reply to an OLDER member of the open conversation ends the hold", async () => {
    const { engine } = await threadedEngine();
    await openH(engine);
    // MUTATION WATCHED: the thread clause narrowed to `m.inReplyTo === held` keeps the hold here.
    expect((await engine.mutate(reply("techcheck"))).status).toBe("confirmed");
    expect(engine.openRowHeld()).toBeNull();
    expect(ids(box(engine).previouslySeen)).toContain("giulia");
  });

  it("threadless: a reply to the held row ends the hold, and so does a forward of it", async () => {
    // MUTATION WATCHED: the fallback replaced with `false` keeps both holds here.
    const engine = await demoEngine();
    expect(engine.holdOpenRow("petra")).toBe(true);
    await engine.mutate({ kind: "mark_seen", messageIds: ["petra"], unread: false, via: "glance" });
    expect((await engine.mutate(reply("petra"))).status).toBe("confirmed");
    expect(engine.openRowHeld()).toBeNull();
    expect(ids(box(engine).previouslySeen)).toContain("petra");

    expect(engine.holdOpenRow("ben")).toBe(true);
    await engine.mutate({
      kind: "mail_send", inReplyTo: null, forwardOf: "ben",
      to: [{ name: "Z", address: "z@example.test" }], body: "fyi",
    });
    expect(engine.openRowHeld()).toBeNull();
  });

  describe("what keeps the hold", () => {
    it("CONTROL: a plain compose keeps the hold, and paints its copy", async () => {
      const { engine } = await threadedEngine();
      await openH(engine);
      const res = await engine.mutate({
        kind: "mail_send", inReplyTo: null, to: [{ name: "Z", address: "z@example.test" }],
        subject: "Hello", body: "new",
      });
      expect(res.status).toBe("confirmed");
      expect(engine.openRowHeld()).toBe("giulia");
      const v = box(engine);
      expect(ids(v.newForYou)).toContain("giulia");
      expect(sentCopies(v.previouslySeen), "the compose's own copy still lands").toHaveLength(1);
    });

    it("CONTROL: a reply into another conversation keeps the hold", async () => {
      const { engine } = await threadedEngine();
      await openH(engine);
      expect((await engine.mutate(reply("petra"))).status).toBe("confirmed");
      expect(engine.openRowHeld()).toBe("giulia");
      expect(ids(box(engine).newForYou)).toContain("giulia");
    });

    it("a Send later keeps the hold: nothing went out", async () => {
      const { engine } = await threadedEngine();
      await openH(engine);
      // MUTATION WATCHED: the `m.sendAt` gate dropped ends the hold here.
      const res = await engine.mutate(reply("giulia", { sendAt: "2026-07-30T08:00:00.000Z" }));
      expect(res.status).toBe("confirmed");
      expect(engine.openRowHeld()).toBe("giulia");
      expect(ids(box(engine).newForYou)).toContain("giulia");
    });

    it("a send queued for the organizer keeps the hold", async () => {
      const { engine, fault } = await threadedEngine();
      await openH(engine);
      fault("queued");
      expect((await engine.mutate(reply("giulia"))).status).toBe("awaiting_organizer");
      expect(engine.openRowHeld()).toBe("giulia");
      expect(ids(box(engine).newForYou)).toContain("giulia");
    });

    it("a refused send keeps the hold, and H stays in New", async () => {
      const { engine, fault } = await threadedEngine();
      await openH(engine);
      fault("refused");
      expect((await engine.mutate(reply("giulia"))).status).toBe("rolled_back");
      expect(engine.openRowHeld()).toBe("giulia");
      expect(ids(box(engine).newForYou)).toContain("giulia");
      expect(sentCopies(box(engine).previouslySeen)).toHaveLength(0);
    });

    it("a retryable failure keeps the hold until the flush confirms, and ends it then", async () => {
      const { engine, fault } = await threadedEngine();
      await openH(engine);
      fault("offline");
      expect((await engine.mutate(reply("giulia"))).status).toBe("queued");
      expect(engine.openRowHeld()).toBe("giulia");
      fault("none");
      const flushed = await engine.flushPending();
      expect(flushed.map((r) => r.status)).toContain("confirmed");
      expect(engine.openRowHeld()).toBeNull();
      expect(ids(box(engine).previouslySeen)).toContain("giulia");
    });

    it("the reader left before the confirm: nothing is held, nothing moves", async () => {
      const { engine } = await threadedEngine();
      await openH(engine);
      engine.releaseOpenRow("giulia");
      expect((await engine.mutate(reply("giulia"))).status).toBe("confirmed");
      expect(engine.openRowHeld()).toBeNull();
      expect(ids(box(engine).newForYou)).toEqual(["petra", "ben"]);
    });
  });
});

/** A bare reader over a fixed list, for the selector's own arms and its memo. */
function readerOf(list: EngineMessage[]): EntityReader {
  return {
    list: <T,>(type: string) => (type === "message" ? list : []) as T[],
    get: <T,>(type: string, id: string) => (type === "message" ? list.find((m) => m.id === id) : undefined) as T | undefined,
    entries: <T,>(type: string) =>
      type === "message" ? list.map((entity, i) => ({ id: entity.id, entity: entity as T, seq: i })) : [],
    version: () => 1,
    stampOf: () => 1,
    stampExcept: () => 1,
  } as EntityReader;
}

function row(id: string, hoursAgo: number, unread: boolean, folder = "INBOX"): EngineMessage {
  const date = new Date(Date.parse("2026-09-26T12:00:00.000Z") - hoursAgo * 36e5).toISOString();
  return {
    id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: id, from: { name: id, address: `${id}@example.test` }, to: [], cc: [],
    date, folder, snippet: "", unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  } as EngineMessage;
}

describe("ohboxView(reader, held) — the selector's arms", () => {
  const mail = [row("a", 1, true), row("b", 2, false), row("c", 3, true), row("d", 4, false), row("e", 5, false)];

  it("the held read row stands in New at its arrival slot, and nowhere else", () => {
    const r = readerOf(mail);
    expect(ids(ohboxView(r, "b").newForYou)).toEqual(["a", "b", "c"]);
    expect(ids(ohboxView(r, "b").previouslySeen)).toEqual(["d", "e"]);
    expect(ids(ohboxView(r, null).newForYou)).toEqual(["a", "c"]);
    expect(ids(ohboxView(r, null).previouslySeen)).toEqual(["b", "d", "e"]);
  });

  it("a held id outside the INBOX is not pulled into New", () => {
    const r = readerOf([...mail, row("f", 0, false, "ohmail/News")]);
    expect(ids(ohboxView(r, "f").newForYou)).toEqual(["a", "c"]);
  });

  it("the memo keys on the held id as well as the version", () => {
    const r = readerOf(mail);
    const held = ohboxView(r, "b");
    expect(ohboxView(r, "b"), "same version, same hold: the memoized object").toBe(held);
    const free = ohboxView(r, null);
    expect(free).not.toBe(held);
    expect(ids(free.newForYou)).toEqual(["a", "c"]);
  });
});
