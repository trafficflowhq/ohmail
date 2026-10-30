import { describe, expect, it } from "vitest";
import {
  FixturesAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  consentPartition,
  ohboxView,
  presentationReader,
  physicalFolderOf,
  type EngineMessage,
  type Folder,
  type FolderEntity,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * HISTORY IS A LENS OVER THE USER'S OWN FOLDERS — spec §16.5, foundation stage.
 *
 * With "Use folders" ON the mirror holds `folder` entities, and the partition treats mail living
 * in one of those folders as FILED rather than as the account's own sent mail:
 *
 *   · it KEEPS ITS PLACE (`placeOf` = its folder), so a folder view shows everything the server
 *     holds there — History must never make a folder look emptier than it is;
 *   · the old-and-read slice from senders nobody ever screened ALSO appears in History, badged by
 *     the folder it lives in — the lens, not a move;
 *   · unread folder mail is NEVER History (the rail's no-badge argument survives the widening);
 *   · a decided sender's folder mail is never History (the cutline is about senders never
 *     screened — unchanged, per the spec).
 *
 * With the flag OFF the mirror has no `folder` entities and every one of these messages takes
 * the pre-feature path byte-for-byte — the first test pins that parity.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");
const RECENT = "2026-07-20T09:00:00.000Z";
const OLD = "2024-03-02T09:00:00.000Z";

let seq = 0;

function msg(o: {
  id: string;
  from: string;
  folder: string;
  date?: string;
  unread?: boolean;
  threadId?: string;
  /** Recipients — on a row in a Sent folder, the account's own record of who it wrote to. */
  to?: string[];
}): EngineMessage {
  return {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: o.threadId ?? null,
    messageIdHeader: null,
    subject: `Subject ${o.id}`,
    from: { name: null, address: o.from },
    to: (o.to ?? []).map((address) => ({ name: null, address })),
    cc: [],
    date: o.date ?? OLD,
    folder: o.folder as Folder,
    snippet: `snippet ${o.id}`,
    unread: o.unread ?? false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: o.date ?? OLD,
  };
}

function folder(name: string, id = `f-${name}`): FolderEntity {
  return { id, name, mailboxId: "mb", mailbox: "a@x.example", updatedAt: OLD };
}

function rule(o: { id: string; match: string; destination: Folder }): RuleDTO {
  return {
    id: o.id,
    kind: "sender",
    match: o.match,
    destination: o.destination,
    priority: 0,
    provenance: "screener-decision",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: OLD,
    updatedAt: OLD,
  };
}

async function mirrorOf(
  messages: EngineMessage[],
  folders: FolderEntity[] = [],
  rules: RuleDTO[] = [],
): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  const changes: SyncChange[] = [
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...folders.map((f) => ({ type: "folder", op: "create", id: f.id, seq: ++seq, updatedAt: f.updatedAt ?? OLD, entity: f })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as SyncChange[];
  await store.applyChanges(changes);
  return store;
}

const opts = { now: NOW };
/** The flag-on option set — the AUTHORITY gate the lens requires beside the entities. */
const onOpts = { now: NOW, foldersEnabled: true };

describe("flag off — no folder entities, the pre-feature partition byte-for-byte", () => {
  it("old folder mail takes the own-sent path: History, and ABSENT from the projection", async () => {
    const store = await mirrorOf([
      msg({ id: "p1", from: "stranger@example.com", folder: "Projects/Acme", date: OLD }),
      msg({ id: "p2", from: "stranger@example.com", folder: "Projects/Acme", date: RECENT }),
    ]);
    const part = consentPartition(store, opts);
    // Pre-feature behaviour, pinned: the old row is History with a null place (removed from the
    // projected list); the recent row keeps its folder. Nothing about a mirror WITHOUT folder
    // entities may change — this is the flag-off parity claim at the partition layer.
    expect(part.history.map((m) => m.id)).toEqual(["p1"]);
    expect(part.placeOf.get("p1")).toBeNull();
    expect(part.placeOf.get("p2")).toBe("Projects/Acme");
    const presented = presentationReader(store, part).list<EngineMessage>("message");
    expect(presented.some((m) => m.id === "p1")).toBe(false);
  });

  it("STALE entities do not resurrect the lens — the flag is the authority, not the mirror", async () => {
    // A mirror can hold folder entities the account has since disabled (a delete this tab never
    // drained, a cached boot). Without the explicit flag the lens would stay on over an
    // interface that says folders are off — the flag-off parity contract, under staleness.
    const store = await mirrorOf(
      [msg({ id: "s1", from: "stranger@example.com", folder: "Projects/Acme", date: OLD })],
      [folder("Projects/Acme")],
    );
    const part = consentPartition(store, { now: NOW, foldersEnabled: false });
    // Pre-feature behaviour exactly: History via the own-sent path, place null, projected away.
    expect(part.history.map((m) => m.id)).toEqual(["s1"]);
    expect(part.placeOf.get("s1")).toBeNull();
  });
});

describe("flag on — folder entities present, History becomes a lens", () => {
  it("old + read + unscreened appears in History AND keeps its place in the folder", async () => {
    const store = await mirrorOf(
      [msg({ id: "l1", from: "stranger@example.com", folder: "Projects/Acme", date: OLD })],
      [folder("Projects/Acme")],
    );
    const part = consentPartition(store, onOpts);
    expect(part.history.map((m) => m.id)).toEqual(["l1"]);
    // THE LENS: History shows it, the folder keeps it. A null place here would make the folder
    // view lie about what the server holds.
    expect(part.placeOf.get("l1")).toBe("Projects/Acme");
    const presented = presentationReader(store, part).list<EngineMessage>("message");
    const row = presented.find((m) => m.id === "l1");
    expect(row).toBeDefined();
    expect(row!.folder).toBe("Projects/Acme");
    // The badge History wears reads the physical folder.
    expect(physicalFolderOf(part.history[0]!)).toBe("Projects/Acme");
  });

  it("unread folder mail is NEVER History — the no-badge invariant survives the widening", async () => {
    const store = await mirrorOf(
      [msg({ id: "u1", from: "stranger@example.com", folder: "Projects/Acme", date: OLD, unread: true })],
      [folder("Projects/Acme")],
    );
    const part = consentPartition(store, onOpts);
    expect(part.history).toEqual([]);
    expect(part.placeOf.get("u1")).toBe("Projects/Acme");
  });

  it("recent folder mail keeps its place and stays out of History", async () => {
    const store = await mirrorOf(
      [msg({ id: "r1", from: "stranger@example.com", folder: "Projects/Acme", date: RECENT })],
      [folder("Projects/Acme")],
    );
    const part = consentPartition(store, onOpts);
    expect(part.history).toEqual([]);
    expect(part.placeOf.get("r1")).toBe("Projects/Acme");
  });

  it("a DECIDED sender's folder mail is never History — the cutline is about senders never screened", async () => {
    const store = await mirrorOf(
      [msg({ id: "d1", from: "known@example.com", folder: "Projects/Acme", date: OLD })],
      [folder("Projects/Acme")],
      [rule({ id: "rule1", match: "known@example.com", destination: "INBOX" })],
    );
    const part = consentPartition(store, onOpts);
    expect(part.history).toEqual([]);
    expect(part.placeOf.get("d1")).toBe("Projects/Acme");
  });

  it("mail OUTSIDE the folder set (the Sent folder) still takes the own-sent path", async () => {
    const store = await mirrorOf(
      [msg({ id: "s1", from: "me@x.example", folder: "INBOX/Sent", date: OLD })],
      [folder("Projects/Acme")],
    );
    const part = consentPartition(store, onOpts);
    // The Sent folder is never a folder entity, so its rows keep pre-feature behaviour: History
    // with a null place.
    expect(part.history.map((m) => m.id)).toEqual(["s1"]);
    expect(part.placeOf.get("s1")).toBeNull();
  });

  it("the thread rule still rescues a lens row onto its consented thread", async () => {
    const store = await mirrorOf(
      [
        msg({ id: "t1", from: "known@example.com", folder: "INBOX", date: RECENT, threadId: "th" }),
        msg({ id: "t2", from: "stranger@example.com", folder: "Projects/Acme", date: OLD, threadId: "th" }),
        // The account's own reply on the thread, naming both. The rescue asks for it: a thread
        // id comes from the header chain, which the sender writes (`sender-headers.ts`).
        msg({
          id: "mine", from: "me@x.example", folder: "INBOX/Sent", date: OLD, threadId: "th",
          to: ["known@example.com", "stranger@example.com"],
        }),
      ],
      [folder("Projects/Acme")],
      [rule({ id: "rule1", match: "known@example.com", destination: "INBOX" })],
    );
    const part = consentPartition(store, onOpts);
    // The conversation holds consented mail, so the filed half leaves History (never split), and
    // it keeps its own folder — the rescue never re-homes filed mail into a reading stream.
    expect(part.history).toEqual([]);
    expect(part.placeOf.get("t2")).toBe("Projects/Acme");
  });

  it("History stays read-only with folder entities present", async () => {
    const store = await mirrorOf(
      [
        msg({ id: "h1", from: "a@example.com", folder: "Projects/Acme", date: OLD }),
        msg({ id: "h2", from: "b@example.com", folder: "Projects/Acme", date: OLD, unread: true }),
        msg({ id: "h3", from: "c@example.com", folder: "ohmail/Screener", date: OLD }),
      ],
      [folder("Projects/Acme")],
    );
    const part = consentPartition(store, onOpts);
    expect(part.history.length).toBeGreaterThan(0);
    expect(part.history.every((m) => !m.unread)).toBe(true);
  });
});

describe("per-mailbox enablement — the lens is mailbox-scoped (spec §17)", () => {
  it("a switched-off mailbox's mail keeps pre-folders behavior even when another mailbox keeps a same-named folder", async () => {
    // Mailbox `mb` still participates and owns Projects/Acme. Mailbox `mb2` was switched off:
    // the server withholds its entities, so the mirror holds NO folder for mb2 — but the NAME
    // exists via mb's entity. The lens must judge each message against ITS OWN mailbox.
    const theirs = msg({ id: "off1", from: "stranger@example.com", folder: "Projects/Acme", date: OLD });
    (theirs as { mailboxId: string }).mailboxId = "mb2";
    const store = await mirrorOf([
      msg({ id: "on1", from: "stranger@example.com", folder: "Projects/Acme", date: OLD }),
      theirs,
    ], [folder("Projects/Acme")]);   // mailboxId: "mb" — the participating mailbox's entity
    const part = consentPartition(store, onOpts);
    // mb's row: the lens — History, badged, place kept.
    expect(part.history.map((m) => m.id)).toContain("on1");
    expect(part.placeOf.get("on1")).toBe("Projects/Acme");
    // mb2's row: pre-folders behavior — History with a NULL place (the own-sent path), exactly
    // what a flag-off mirror does with it.
    expect(part.history.map((m) => m.id)).toContain("off1");
    expect(part.placeOf.get("off1")).toBeNull();
  });

  it("an entity without a mailboxId (an older server) keeps the name-only reach", async () => {
    const f = folder("Projects/Acme");
    delete (f as { mailboxId?: string }).mailboxId;
    const other = msg({ id: "m2", from: "stranger@example.com", folder: "Projects/Acme", date: OLD });
    (other as { mailboxId: string }).mailboxId = "mb2";
    const store = await mirrorOf([other], [f]);
    const part = consentPartition(store, onOpts);
    // Degrades to the pre-§17 lens, never to off: the row keeps its place and joins History.
    expect(part.placeOf.get("m2")).toBe("Projects/Acme");
  });
});

/* A localized Sent folder ('Envoyés') is announced as a user folder (the server knows Sent by name
   only). Once the mailbox read states it as the recorded Sent folder it takes the Sent cutline as
   'Sent' does: old own letters are History, never the whole backlog poured into Earlier. */
describe("the mailbox's recorded Sent folder under Use folders", () => {
  const OLDER = "2022-11-02T09:00:00.000Z";
  const own = (id: string, mailboxId: string, folderName: string, date: string) => {
    const m = msg({ id, from: "me@x.example", folder: folderName, date });
    (m as { mailboxId: string }).mailboxId = mailboxId;
    return m;
  };
  const world = () => [
    own("en-new", "mb-en", "Sent", RECENT), own("en-old", "mb-en", "Sent", OLD),
    own("fr-new", "mb-fr", "Envoyés", RECENT), own("fr-old", "mb-fr", "Envoyés", OLD),
    own("fr-older", "mb-fr", "Envoyés", OLDER),
  ];
  const fr = (): FolderEntity => ({ ...folder("Envoyés", "f-fr"), mailboxId: "mb-fr" });
  async function lists(foldersEnabled: boolean) {
    const store = await mirrorOf(world(), [fr()]);
    const part = consentPartition(store, { now: NOW, foldersEnabled, ownAddresses: ["me@x.example"] });
    const presented = presentationReader(store, part);
    return {
      earlier: ohboxView(presented).previouslySeen.map((m) => m.id).sort(),
      history: part.history.map((m) => m.id).sort(),
      // The rail folder's own list: the presented mirror on (mailboxId, name), as web and phone filter it.
      envoyes: presented.list<EngineMessage>("message")
        .filter((m) => m.mailboxId === "mb-fr" && m.folder === "Envoyés").map((m) => m.id).sort(),
    };
  }

  it("stated: folders on files the old letters in History, as 'Sent' and as folders off", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => NOW });
    await engine.start();
    try {
      engine.setSentFolders([{ id: "mb-fr", sentFolder: "Envoyés" }]);
      const want = { earlier: ["en-new", "fr-new"], history: ["en-old", "fr-old", "fr-older"] };
      const on = await lists(true);
      expect({ earlier: on.earlier, history: on.history }).toEqual(want);
      // History never makes the folder look emptier than it is: the 'Envoyés' folder stays whole.
      expect(on.envoyes).toEqual(["fr-new", "fr-old", "fr-older"]);
      const off = await lists(false);
      expect({ earlier: off.earlier, history: off.history }).toEqual(want);
    } finally {
      engine.setSentFolders([]);
    }
  });

  it("stated: an old own reply on a conversation a consented sender keeps stays with it in Earlier", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => NOW });
    await engine.start();
    try {
      engine.setSentFolders([{ id: "mb-fr", sentFolder: "Envoyés" }]);
      const letter = { ...msg({ id: "in", from: "known@example.com", folder: "INBOX", date: RECENT, threadId: "t" }), mailboxId: "mb-fr" };
      const reply = {
        ...msg({ id: "re", from: "me@x.example", folder: "Envoyés", date: OLD, threadId: "t", to: ["known@example.com"] }),
        mailboxId: "mb-fr",
      };
      const store = await mirrorOf([letter, reply], [fr()], [rule({ id: "r1", match: "known@example.com", destination: "INBOX" })]);
      const part = consentPartition(store, { now: NOW, foldersEnabled: true, ownAddresses: ["me@x.example"] });
      expect(part.history.map((m) => m.id)).toEqual([]);
      expect(ohboxView(presentationReader(store, part)).previouslySeen.map((m) => m.id).sort()).toEqual(["in", "re"]);
    } finally {
      engine.setSentFolders([]);
    }
  });

  it("unstated: 'Envoyés' is somebody's folder, never in Earlier", async () => {
    const on = await lists(true);
    expect(on.earlier).toEqual(["en-new"]);
    expect(on.envoyes).toEqual(["fr-new", "fr-old", "fr-older"]);
    expect((await lists(false)).earlier).toEqual(["en-new"]);
  });
});
