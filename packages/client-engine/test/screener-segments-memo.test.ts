import type { EngineMessage, Folder, RuleEntity as RuleDTO, ScreenerSenderDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  consentPartition,
  presentationReader,
  screenerSegments,
  type EntityReader,
  type ScreenerSegments,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * ONE QUEUE DERIVATION PER MIRROR VERSION, AND ONLY THE SENDERS A BUMP TOUCHED.
 *
 * `screenerSegments` walked the whole mailbox and minted every row on every version bump, and the
 * shell asks for it on every bump whether or not the Screener is open. Measured over a real store
 * and the real projection (`test/rigs/screener-segments-rig.mjs`): milliseconds at a modest queue
 * and tens of milliseconds at a large one, every bump, with most of it in
 * the per-message stamp. Two caches answer it — one keyed on (reader, version, day, zone, locale,
 * own set) so callers of one bump share a derivation, one keyed on the sender's own bag BY ENTITY
 * IDENTITY so a bump re-derives the senders it touched and nobody else.
 *
 * The wall-clock figures live in the project's design notes and in the rig, never here: a
 * millisecond assertion in a suite is a flake. What is guarded here is the only thing that makes
 * a cache safe — that it answers exactly what the full derivation answers.
 */

const NOW = new Date("2026-09-12T09:00:00.000Z");
const ZONE = "Europe/Zurich";

let seq = 0;

function msg(o: {
  id: string;
  from: string;
  folder: string;
  date?: string;
  unread?: boolean;
}): EngineMessage {
  const date = o.date ?? "2026-09-10T08:00:00.000Z";
  return {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${o.id}`,
    from: { name: null, address: o.from },
    to: [],
    cc: [],
    date,
    folder: o.folder as Folder,
    snippet: `snippet ${o.id}`,
    unread: o.unread ?? false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: date,
  };
}

function rule(id: string, match: string, destination: Folder): RuleDTO {
  return {
    id, kind: "sender", match, destination, priority: 0, provenance: "seeded-from-sent",
    enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  };
}

async function mirrorOf(messages: EngineMessage[], rules: RuleDTO[] = []): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
  ] as SyncChange[]);
  return store;
}

/** The shell's own composition: one partition, one projection, per bump. */
function presented(store: MemoryMirrorStore, own: readonly string[] = []): EntityReader {
  return presentationReader(store, consentPartition(store, { now: NOW, ownAddresses: own }));
}

const derive = (r: EntityReader, now: Date = NOW, locale = "en", zone = ZONE, own?: readonly string[]): ScreenerSegments =>
  screenerSegments(r, now, locale, zone, own);

/** Every row the three shelves hold, flattened — what two derivations must agree on. */
const shape = (s: ScreenerSegments): unknown =>
  JSON.parse(JSON.stringify({ waiting: s.waiting, screenedOut: s.screenedOut, spam: s.spam }));

/**
 * A COLD DERIVATION OVER THE SAME FACTS. The caches key on entity IDENTITY, so a second mirror
 * built from structural clones shares nothing with the live one and derives from scratch — which
 * is the only honest reference for an incremental answer.
 */
async function coldOf(
  store: MemoryMirrorStore, own: readonly string[] = [], now: Date = NOW,
): Promise<ScreenerSegments> {
  const shadow = new MemoryMirrorStore();
  await shadow.load();
  let s = 0;
  const rows = store.entries<EngineMessage>("message")
    .map((e) => ({ type: "message", op: "create", id: e.id, seq: ++s, updatedAt: e.entity.updatedAt, entity: structuredClone(e.entity) }));
  const rules = store.entries<RuleDTO>("rule")
    .map((e) => ({ type: "rule", op: "create", id: e.id, seq: ++s, updatedAt: e.entity.updatedAt, entity: structuredClone(e.entity) }));
  await shadow.applyChanges([...rules, ...rows] as SyncChange[]);
  for (const b of store.entries<unknown>("message_body")) {
    await shadow.putLocal("message_body", b.id, structuredClone(b.entity));
  }
  return derive(presented(shadow, own), now, "en", ZONE, own);
}

/** A reader that counts what the derivation asks it for — the work, not the answer. */
function counting(inner: EntityReader): { reader: EntityReader; lists: () => number } {
  let lists = 0;
  return {
    lists: () => lists,
    reader: {
      get: (t, id) => inner.get(t, id),
      entries: (t) => inner.entries(t),
      list: (t) => { if (t === "message") lists++; return inner.list(t); },
      version: () => inner.version(),
    } as EntityReader,
  };
}

const queue = [
  msg({ id: "a1", from: "ann@senders.test", folder: "ohmail/Screener", unread: true }),
  msg({ id: "a2", from: "ann@senders.test", folder: "ohmail/Screener", date: "2026-09-02T08:00:00.000Z" }),
  msg({ id: "b1", from: "bob@senders.test", folder: "ohmail/Screener", unread: true }),
  msg({ id: "c1", from: "cy@senders.test", folder: "ohmail/Screened" }),
  msg({ id: "d1", from: "dee@senders.test", folder: "ohmail/Quarantine" }),
  msg({ id: "e1", from: "friend@senders.test", folder: "INBOX", unread: true }),
  /* SIX DAYS OLD, so this row sits on the LAST day of the weekday band ("Sun 10:00") and crosses
     into the dated band ("6 Sep") the moment the clock does. Without a row on that edge every
     stamp in this fixture reads the same on both days and a cache that ignored the day would
     pass — the hole a property test has to be given on purpose. */
  msg({ id: "g1", from: "gus@senders.test", folder: "ohmail/Screener", unread: true,
        date: "2026-09-06T08:00:00.000Z" }),
];
/* `friend` is ADMITTED, so their INBOX mail keeps its place: an unruled active sender's inbox
   mail is re-homed to the gate by the cutline and would queue beside the two real waiting rows,
   which is a fact about the partition and not about these caches. */
const queueStore = (): Promise<MemoryMirrorStore> =>
  mirrorOf(queue, [rule("rf", "friend@senders.test", "INBOX")]);
/** The row for one sender, by ADDRESS — the shelf's order is the rep's date and not a fixture. */
const rowFor = (s: ScreenerSegments, address: string): ScreenerSenderDTO =>
  s.waiting.find((w) => w.from.address === address)!;

describe("one derivation per mirror version", () => {
  it("FIVE CALLERS ON ONE BUMP READ ONE DERIVATION, NOT FIVE", async () => {
    // THE GUARD. Delete the `segmentsCache` lookup in `screenerSegments()` and the count is 5:
    // every caller of one bump walks the whole mailbox again. The shell asks for this on every
    // bump whether or not the Screener is on screen, and the phone's world memo re-derives on
    // twenty-two dependencies of which the version is one.
    const store = await queueStore();
    const { reader, lists } = counting(presented(store));
    const first = derive(reader);
    for (let i = 0; i < 4; i++) {
      const again = derive(reader);
      // The SAME answer, not an equal one — the whole point is that no second derivation ran.
      expect(again).toBe(first);
    }
    expect(lists(), "one walk of the mailbox for five callers").toBe(1);
  });

  it("A BUMP INVALIDATES IT — the version is the key, never the reader alone", async () => {
    // THE GUARD. Drop `hit.v === reader.version()` from the lookup and this goes red: the queue
    // freezes at whatever it held when the window opened and a screened sender never leaves it.
    const store = await queueStore();
    const r1 = presented(store);
    expect(rowFor(derive(r1), "ann@senders.test").held.map((h) => h.subject))
      .toEqual(["Subject a2", "Subject a1"]);
    await store.applyChanges([
      { type: "message", op: "update", id: "a1", seq: ++seq, updatedAt: NOW.toISOString(),
        entity: { ...store.get<EngineMessage>("message", "a1")!, subject: "Re: Subject a1" } },
    ] as SyncChange[]);
    // THE SAME READER OBJECT, a new version. A projection is rebuilt per bump in the shell, so a
    // reader-keyed cache would usually be missed rather than stale — which is exactly why the
    // version has to be in the key rather than relied on to change the key by itself.
    expect(rowFor(derive(r1), "ann@senders.test").held.map((h) => h.subject))
      .toEqual(["Subject a2", "Re: Subject a1"]);
  });

  it("THE CLOCK ENTERS AS A DAY, AND THE DAY IS IN THE KEY", async () => {
    // Two callers milliseconds apart are asking one question; a caller on the next day is not.
    // THE GUARD. Drop `day` from the key and the second expectation goes red — the stamps stay
    // on yesterday's band, so a window left open overnight shows "Fri 09:12" for mail that is
    // now two days old.
    const store = await queueStore();
    const r = presented(store);
    expect(derive(r, new Date(NOW.getTime() + 1))).toBe(derive(r, NOW));
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    const later = derive(r, tomorrow);
    expect(later).not.toBe(derive(r, NOW));
    // And the new band is the band a cold derivation mints, not merely a different object.
    expect(shape(later)).toEqual(shape(await coldOf(store, [], tomorrow)));
  });

  it("THE LOCALE, THE ZONE AND THE OWN SET ARE EACH IN THE KEY", async () => {
    /**
     * THE GUARD. Remove any one of the three from the key and its own arm goes red: the Screener
     * keeps English stamps after a language switch, keeps UTC stamps for a reader two hours east,
     * or keeps the reader in their own queue.
     *
     * EACH ARM RE-FILLS THE CACHE FIRST, and each asserts on the ANSWER rather than on object
     * identity. The cache holds one entry per reader, so a run that varied two things in a row
     * missed on the first variation and recomputed for reasons that had nothing to do with the
     * key under test — three arms in sequence passed against a key missing two of the three.
     */
    const store = await queueStore();
    const r = presented(store);
    const stamps = (s: ScreenerSegments): string[] => s.waiting.flatMap((w) => w.held.map((h) => h.time));

    const forZone = derive(r, NOW, "en", ZONE, []);
    expect(stamps(derive(r, NOW, "en", "UTC", []))).not.toEqual(stamps(forZone));

    const forLocale = derive(r, NOW, "en", ZONE, []);
    expect(stamps(derive(r, NOW, "de", ZONE, []))).not.toEqual(stamps(forLocale));

    const forOwn = derive(r, NOW, "en", ZONE, []);
    expect(forOwn.waiting.map((w) => w.from.address)).toContain("ann@senders.test");
    expect(derive(r, NOW, "en", ZONE, ["ann@senders.test"]).waiting.map((w) => w.from.address))
      .not.toContain("ann@senders.test");
  });
});

describe("the incremental answer is the full derivation's answer", () => {
  it("EQUAL TO A COLD DERIVATION ACROSS RANDOMISED DELTAS", async () => {
    /**
     * THE PROPERTY, and the reason the caches are safe at all. Forty rounds of arbitrary deltas
     * over a live mirror, each compared against a mirror rebuilt from CLONES — which shares no
     * entity object with the live one, so it derives from scratch. The deltas carry holes and
     * off-by-one sizes on purpose (a round that touches nothing, one that touches a single
     * message, one that touches every message but one, a sender losing their last message, a
     * sender's mail crossing between shelves, a body arriving) so alignment cannot pass for a
     * property.
     *
     * THE GUARD. Any of these turns it red: dropping the body record from either cache's key
     * (an arriving body stops filling in its preview), keying the sender aggregate on the
     * address rather than the bag (a sender's new mail never appears), comparing the bag by
     * length alone (a replaced message keeps the old row), or dropping `segment` from the entry.
     */
    let n = 0;
    const rows: EngineMessage[] = [];
    for (let s = 0; s < 12; s++) {
      // Uneven bags: an even bag lets an off-by-one in the per-sender loop pass for a property.
      for (let k = 0; k <= s % 4; k++) {
        rows.push(msg({
          id: `m${n++}`, from: `s${s}@senders.test`,
          folder: s % 5 === 0 ? "ohmail/Screened" : s % 7 === 0 ? "ohmail/Quarantine" : "ohmail/Screener",
          date: new Date(NOW.getTime() - (s * 4 + k) * 3_600_000).toISOString(),
          unread: k === 0,
        }));
      }
    }
    const store = await mirrorOf(rows, [rule("r1", "friend@senders.test", "INBOX")]);
    const own = ["me@own.test"];

    // A deterministic generator: a failing round has to be reproducible.
    let rnd = 0x51ed270b;
    const next = (): number => {
      rnd ^= rnd << 13; rnd >>>= 0; rnd ^= rnd >>> 17; rnd ^= rnd << 5; rnd >>>= 0;
      return rnd / 0x1_0000_0000;
    };
    const FOLDERS: Folder[] = ["ohmail/Screener", "ohmail/Screened", "ohmail/Quarantine", "INBOX"];

    for (let round = 0; round < 40; round++) {
      const live = store.entries<EngineMessage>("message");
      const changes: SyncChange[] = [];
      // Round 0 touches nothing; round 1 touches exactly one; round 2 every row but one.
      const touch = round === 0 ? 0 : round === 1 ? 1 : round === 2 ? live.length - 1
        : Math.floor(next() * (live.length + 1));
      for (let i = 0; i < touch && i < live.length; i++) {
        const pick = live[Math.floor(next() * live.length)]!;
        const roll = next();
        if (roll < 0.15) {
          changes.push({ type: "message", op: "delete", id: pick.id, seq: ++seq, updatedAt: NOW.toISOString() } as SyncChange);
        } else if (roll < 0.5) {
          changes.push({ type: "message", op: "update", id: pick.id, seq: ++seq, updatedAt: NOW.toISOString(),
            entity: { ...pick.entity, folder: FOLDERS[Math.floor(next() * FOLDERS.length)]! } } as SyncChange);
        } else if (roll < 0.8) {
          changes.push({ type: "message", op: "update", id: pick.id, seq: ++seq, updatedAt: NOW.toISOString(),
            entity: { ...pick.entity, unread: !pick.entity.unread, subject: `Re: ${pick.entity.subject}` } } as SyncChange);
        } else {
          changes.push({ type: "message", op: "create", id: `n${round}-${i}`, seq: ++seq, updatedAt: NOW.toISOString(),
            entity: msg({ id: `n${round}-${i}`, from: `s${Math.floor(next() * 14)}@senders.test`,
              folder: FOLDERS[Math.floor(next() * FOLDERS.length)]!,
              date: new Date(NOW.getTime() - Math.floor(next() * 40) * 3_600_000).toISOString() }) } as SyncChange);
        }
      }
      if (changes.length > 0) await store.applyChanges(changes);
      // A body arriving on every third round — the one input neither cache can see in the bag.
      if (round % 3 === 0 && live.length > 0) {
        const target = live[Math.floor(next() * live.length)]!;
        await store.putLocal("message_body", target.id, {
          state: "ready", text: `body for ${target.id} round ${round}`, html: null,
          loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null, withheld: null,
        });
      }
      const incremental = derive(presented(store, own), NOW, "en", ZONE, own);
      expect(shape(incremental), `round ${round}`).toEqual(shape(await coldOf(store, own)));
    }
  });

  it("AN ARRIVING BODY FILLS IN THE PREVIEW IT BELONGS TO", async () => {
    // The hole a bag comparison alone leaves: a `message_body` is client-local, so it changes no
    // message row and no bucket. THE GUARD. Drop `bodies` from `sameBag`, or `body` from the held
    // entry, and the preview a consent decision is taken on stays at its one-line snippet for as
    // long as the window is open.
    const store = await queueStore();
    expect(rowFor(derive(presented(store)), "ann@senders.test").held[0]!.body).toBe("snippet a2");
    await store.putLocal("message_body", "a2", {
      state: "ready", text: "the whole message", html: "<p>the whole message</p>",
      loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null, withheld: null,
    });
    const row = rowFor(derive(presented(store)), "ann@senders.test");
    expect(row.held[0]!.body).toBe("the whole message");
    expect(row.held[0]!.bodyState).toBe("full");
  });

  it("A SENDER WHO LOSES A MESSAGE RE-DERIVES — the off-by-one the bag length catches", async () => {
    // THE GUARD. Compare the bag by its first element alone (or by length alone, with a delete
    // and a create in one page) and the row keeps naming mail that is gone.
    const store = await queueStore();
    expect(rowFor(derive(presented(store)), "ann@senders.test").held).toHaveLength(2);
    await store.applyChanges([
      { type: "message", op: "delete", id: "a2", seq: ++seq, updatedAt: NOW.toISOString() },
    ] as SyncChange[]);
    const after = rowFor(derive(presented(store)), "ann@senders.test");
    expect(after.held.map((h) => h.id)).toEqual(["a1"]);
  });
});
