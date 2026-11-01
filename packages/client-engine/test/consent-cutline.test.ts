import { describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import {
  DEFAULT_DORMANCY_DAYS,
  MemoryMirrorStore,
  consentPartition,
  cutlineFor,
  historyView,
  ohboxView,
  physicalFolderOf,
  presentationReader,
  readsPartition,
  screenerSegments,
  senderActivity,
  type EngineMessage,
  type Folder,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import {
  DEFAULT_OHBOX_POLICY, evaluateRules, type AuthVerdict, type NormalizedMessage, type Rule,
} from "@trafficflow/core/mail";

/**
 * CONSENT, THE CUTLINE, AND HISTORY.
 *
 * The model these guard: mail is presented by WHO SENT IT, not by where it happens to sit on
 * the server. Nothing here moves any mail, so every assertion is about presentation, and the
 * physical folder each message keeps is asserted alongside it.
 *
 * The cases were chosen because each of them is a way the model could be quietly wrong on a
 * real mailbox rather than on a tidy one: mail that is old AND unread, a dormant sender who
 * comes back, a consented sender whose backlog was never moved, and a thread with one of each
 * kind of participant on it.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");
/** Comfortably inside the 60-day window. */
const RECENT = "2026-07-20T09:00:00.000Z";
/** Comfortably outside it. */
const OLD = "2024-03-02T09:00:00.000Z";

let seq = 0;

function msg(o: {
  id: string;
  from: string;
  folder: string;
  /** `null` is a message whose sender sent no `Date:` header — the wire's own nullable field. */
  date?: string | null;
  /** The arrival (`messages.created_at` on the wire). Absent ⇒ a mirror row older than the field. */
  arrivedAt?: string;
  /** The wire's sort key: the header clamped to the server's receipt (mail 0119). */
  sortAt?: string;
  unread?: boolean;
  threadId?: string;
  /** Recipients — on a row in a Sent folder these are the account's own record of who it wrote to. */
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
    date: o.date === undefined ? OLD : o.date,
    ...(o.arrivedAt === undefined ? {} : { arrivedAt: o.arrivedAt }),
    ...(o.sortAt === undefined ? {} : { sortAt: o.sortAt }),
    folder: o.folder as Folder,
    snippet: `snippet ${o.id}`,
    unread: o.unread ?? false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    // NOT a stand-in for the arrival: `updated_at` moves on every write to the row, so a fixture
    // that let the cutline read it would pass for a rule nothing shipped.
    updatedAt: o.date ?? OLD,
  };
}

function rule(o: {
  id: string;
  kind: RuleDTO["kind"];
  match: string;
  destination: Folder;
  enabled?: boolean;
  provenance?: RuleDTO["provenance"];
}): RuleDTO {
  return {
    id: o.id,
    kind: o.kind,
    match: o.match,
    destination: o.destination,
    priority: 0,
    provenance: o.provenance ?? "seeded-from-sent",
    enabled: o.enabled ?? true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: OLD,
    updatedAt: OLD,
  };
}

async function mirrorOf(messages: EngineMessage[], rules: RuleDTO[] = []): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  const changes: SyncChange[] = [
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as SyncChange[];
  await store.applyChanges(changes);
  return store;
}

const opts = { now: NOW };

/** The gate's own answer for a claim naming PostFinance from `from`, under one rule and verdict: is it held? */
function gateHolds(from: string, r: RuleDTO, auth: AuthVerdict, lists: readonly string[] = []): boolean {
  const m: NormalizedMessage = {
    canonical: { messageIdHeader: null, bodyHash: "" }, subject: "Ihre Karte",
    from: { name: "PostFinance", address: from }, to: [], cc: [], date: null, headers: {},
    textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
  };
  const core: Rule = {
    id: r.id, kind: r.kind as Rule["kind"], match: r.match, destination: r.destination as Rule["destination"],
    effect: "allow", priority: r.priority, provenance: r.provenance as Rule["provenance"], enabled: r.enabled,
    subjectContains: null, bodyContains: null,
  };
  return evaluateRules({
    msg: m, rules: [core], ownAddresses: new Set(),
    knownSenders: { addresses: new Set(), inferred: new Set(), lists: new Map(lists.map((a) => [a, new Set<string>()])) },
    auth, ohboxPolicy: DEFAULT_OHBOX_POLICY, identity: { brand: "PostFinance", via: "name" },
  }).source === "screener";
}

describe("the cutline decides who is still owed a decision", () => {
  it("OLD AND UNREAD IS ACTIVE — age never outvotes unread", async () => {
    // The case the whole no-badge invariant rests on. If age were allowed to win, a sender
    // with four-year-old unopened mail would be filed as dormant, that mail would land in
    // History, and History would be holding something unread.
    const store = await mirrorOf([
      msg({ id: "a1", from: "stale@example.com", folder: "ohmail/Screener", date: OLD, unread: true }),
      msg({ id: "b1", from: "quiet@example.com", folder: "ohmail/Screener", date: OLD, unread: false }),
    ]);
    const activity = senderActivity(store.list<EngineMessage>("message"), opts);

    expect(activity.get("stale@example.com")).toBe("active");
    expect(activity.get("quiet@example.com")).toBe("dormant");

    const part = consentPartition(store, opts);
    expect(part.history.map((m) => m.id)).toEqual(["b1"]);
  });

  it("A HELD CLAIM IS NEVER DORMANT — its Date is the sender's to write (mail 0148)", async () => {
    // Dated by its arrival key: the server's `sortAt` is the arrival when the header strays from it.
    const fact = { reason: "impersonation" as const, brand: "PostFinance", domainShared: false };
    const claim = { ...msg({ id: "c1", from: "claim@example.com", folder: "ohmail/Screener", date: OLD, unread: false }),
      sortAt: RECENT, senderCheck: fact };
    const plain = msg({ id: "p1", from: "plain@example.com", folder: "ohmail/Screener", date: OLD, unread: false });
    // A claim that ARRIVED before the cutline, as the identity backfill finds it, stays dormant (0.25.19).
    const historical = { ...msg({ id: "h1", from: "old-claim@example.com", folder: "ohmail/Screener", date: OLD, unread: false }),
      senderCheck: fact };
    const store = await mirrorOf([claim, plain, historical]);
    const activity = senderActivity(store.list<EngineMessage>("message"), opts);
    expect(activity.get("claim@example.com")).toBe("active");
    expect(activity.get("plain@example.com")).toBe("dormant");
    expect(activity.get("old-claim@example.com")).toBe("dormant");
    const part = consentPartition(store, opts);
    expect(part.history.map((m) => m.id).sort()).toEqual(["h1", "p1"]);
  });

  it("A PERSON'S CONSENT TO THE ADDRESS OUTRANKS A HELD CLAIM — the gate holds none of theirs (FIX-026)", async () => {
    // `senderHasHeldClaimSql`'s person half, over what the mirror carries: a person's allow `sender`
    // rule naming the address. Inference and a disabled rule are no such consent; their claims stay active.
    const fact = { reason: "impersonation" as const, brand: "PostFinance", domainShared: false };
    const claimOf = (id: string, from: string) => ({
      ...msg({ id, from, folder: "ohmail/Screener", date: OLD, unread: false }), sortAt: RECENT, senderCheck: fact,
    });
    const store = await mirrorOf(
      [claimOf("m1", "typed@example.com"), claimOf("m2", "imported@example.com"), claimOf("m3", "seeded@example.com"),
        claimOf("c1", "pressed@example.com"), claimOf("c2", "info@ruled.example"), claimOf("c3", "off@example.com")],
      [rule({ id: "r1", kind: "sender", match: " Typed@Example.com ", destination: "INBOX", provenance: "manual" }),
        rule({ id: "r2", kind: "sender", match: "imported@example.com", destination: "ohmail/News", provenance: "migrated" }),
        rule({ id: "r3", kind: "sender", match: "seeded@example.com", destination: "INBOX", provenance: "seeded-from-sent" }),
        rule({ id: "r4", kind: "sender", match: "pressed@example.com", destination: "INBOX", provenance: "promoted" }),
        rule({ id: "r5", kind: "domain", match: "ruled.example", destination: "INBOX", provenance: "manual" }),
        rule({ id: "r6", kind: "sender", match: "off@example.com", destination: "INBOX", provenance: "manual", enabled: false })],
    );
    const part = consentPartition(store, opts);
    for (const s of ["typed@example.com", "imported@example.com", "seeded@example.com"]) {
      expect(part.activity.get(s), s).toBe("dormant");
    }
    for (const s of ["pressed@example.com", "info@ruled.example", "off@example.com"]) {
      expect(part.activity.get(s), s).toBe("active");
    }
    // Decided and dormant at the gate is RETIRED, so no waiting row names them; the inferred two are not.
    expect([...part.retiredDecided].sort()).toEqual(["imported@example.com", "seeded@example.com", "typed@example.com"]);
  });

  it("THE PERSON SKIP YIELDS ONLY WHERE THE GATE WOULD NOT HOLD THE ROW (REVIEW-026 HIGH-1): every verdict, both ways", async () => {
    // Each claim comes from an address a person typed a rule for and carries one stored verdict (the
    // vocabulary is a `Record` over the type, so a new member cannot be left out); the gate's own answer
    // for a claim carrying it decides whether it keeps the sender active. The census meets both answers.
    const VOCABULARY: Record<AuthVerdict, true> = { unauthenticated: true, unavailable: true, pass: true, fail: true };
    const stored: ReadonlyArray<AuthVerdict | null | undefined> = [...(Object.keys(VOCABULARY) as AuthVerdict[]), null, undefined];
    const fact = { reason: "impersonation" as const, brand: "PostFinance", domainShared: false };
    const answers = new Set<boolean>();
    for (const [i, v] of stored.entries()) {
      const from = `typed${i}@example.com`;
      const typed = rule({ id: `t${i}`, kind: "sender", match: from, destination: "INBOX", provenance: "manual" });
      const claim = { ...msg({ id: `v${i}`, from, folder: "ohmail/Screener", date: OLD, unread: false }),
        sortAt: RECENT, senderCheck: fact, ...(v === undefined ? {} : { authVerdict: v }) };
      const holds = gateHolds(from, typed, v ?? "unauthenticated");
      answers.add(holds);
      const store = await mirrorOf([claim], [typed]);
      expect(consentPartition(store, opts).activity.get(from), String(v)).toBe(holds ? "active" : "dormant");
    }
    expect([...answers].sort()).toEqual([false, true]);
  });

  it("A LIST ADDRESS'S HELD CLAIM IS NEVER SKIPPED (mail 0150) — no rule naming it consents a company's name", async () => {
    // The gate answers a list address alone: only a brand a press consented there, never the Sent seed's
    // rule the person's post made. The wire's `senderCheck.list` names such a claim; the same rule over
    // an address no list posts as is a person's consent, and the claim is skipped.
    const fact = { reason: "impersonation" as const, brand: "PostFinance", domainShared: false };
    const seeded = (id: string, from: string) =>
      rule({ id, kind: "sender", match: from, destination: "INBOX", provenance: "seeded-from-sent" });
    const claim = (id: string, from: string, list: boolean) => ({
      ...msg({ id, from, folder: "ohmail/Screener", date: OLD, unread: false }), sortAt: RECENT,
      senderCheck: list ? { ...fact, list: true } : fact,
    });
    const store = await mirrorOf(
      [claim("l1", "list@lists.example", true), claim("p1", "person@example.com", false)],
      [seeded("s1", "list@lists.example"), seeded("s2", "person@example.com")],
    );
    const part = consentPartition(store, opts);
    expect(part.activity.get("list@lists.example"), "a list address's claim").toBe("active");
    expect(part.activity.get("person@example.com"), "CONTROL: the same rule over a person's address").toBe("dormant");
    expect(gateHolds("list@lists.example", seeded("s1", "list@lists.example"), "unauthenticated", ["list@lists.example"])).toBe(true);
    expect(gateHolds("person@example.com", seeded("s2", "person@example.com"), "unauthenticated")).toBe(false);
  });

  it("A CLAIM IS DATED BY WHO WROTE THE FACT (mail 0149) — the server's `heldClaimInsideSql`", async () => {
    const claimOf = (id: string, o: { by?: "ingest" | "backfill"; recorded?: string; sortAt?: string; date?: string }) => ({
      ...msg({ id, from: `${id}@example.com`, folder: "ohmail/Screener", date: o.date ?? OLD, unread: false,
        ...(o.recorded === undefined ? {} : { arrivedAt: o.recorded }) }),
      ...(o.sortAt === undefined ? {} : { sortAt: o.sortAt }),
      senderCheck: { reason: "impersonation" as const, brand: "PostFinance", domainShared: false, ...(o.by ? { by: o.by } : {}) },
    });
    // The first import finished inside the window, before RECENT.
    const DURING = "2026-07-10T09:00:00.000Z";
    const DONE = "2026-07-10T10:00:00.000Z";
    // Every Date is OLD and every sender decided by the act (so the gate's arrival clock reads none
    // of them and no person consented): only the claim could keep a sender active.
    const ids = ["backfilled", "ingested", "imported", "ingested-long-ago", "older-build", "older-build-no-arrival"];
    const decided = ids.map((id) => rule({ id: `r-${id}`, kind: "sender", match: `${id}@example.com`, destination: "INBOX", provenance: "promoted" }));
    const store = await mirrorOf([
      // Backfilled: never, however recent its arrival.
      claimOf("backfilled", { by: "backfill", recorded: RECENT, sortAt: RECENT }),
      // Ingest: by its record time, once the import had finished; not by the Date, not by the arrival.
      claimOf("ingested", { by: "ingest", recorded: RECENT }),
      claimOf("imported", { by: "ingest", recorded: DURING, sortAt: DURING }),
      claimOf("ingested-long-ago", { by: "ingest", recorded: OLD, sortAt: RECENT }),
      // Marked by an older build: the arrival key, as in 0.25.19.
      claimOf("older-build", { sortAt: RECENT }),
      claimOf("older-build-no-arrival", { recorded: RECENT }),
    ], decided);
    const activity = (imports?: Readonly<Record<string, string | null>>) =>
      consentPartition(store, imports === undefined ? opts : { ...opts, firstImportDoneAt: imports }).activity;
    const finished = activity({ mb: DONE });
    expect(Object.fromEntries([...finished].map(([k, v]) => [k.split("@")[0], v]))).toEqual({
      "backfilled": "dormant", "ingested": "active", "imported": "dormant", "ingested-long-ago": "dormant",
      "older-build": "active", "older-build-no-arrival": "dormant",
    });
    // A mailbox still importing lists nothing its import records; one the read does not name, or no
    // read at all, is taken as finished — the claim is listed rather than lost.
    expect(activity({ mb: null }).get("ingested@example.com")).toBe("dormant");
    expect(activity({ other: DONE }).get("ingested@example.com")).toBe("active");
    // An inherited name is no mailbox's stamp: a record with a poisoned prototype reads as unnamed.
    expect(activity(Object.create({ mb: null }) as Record<string, string | null>).get("ingested@example.com")).toBe("active");
    expect(activity().get("ingested@example.com")).toBe("active");
    expect(activity().get("backfilled@example.com")).toBe("dormant");
  });

  it("…judged by the ORGANIZER'S rules on a mailbox this install only reads", async () => {
    const fact = { reason: "impersonation" as const, brand: "PostFinance", domainShared: false };
    const onRead = { ...msg({ id: "r1", from: "typed@example.com", folder: "ohmail/Screener", date: OLD }),
      mailboxId: "mb-read", sortAt: RECENT, senderCheck: fact };
    const store = await mirrorOf([onRead]);
    const profileOf = (provenance: RuleDTO["provenance"]) => ({
      mailboxId: "mb-read", asOf: RECENT, from: { kind: "local", name: "Host", since: null }, updatedAt: RECENT,
      rules: [rule({ id: `profile:mb-read:${provenance}`, kind: "sender", match: "typed@example.com", destination: "INBOX", provenance })],
    });
    await store.applyChanges([{ type: "mailbox_profile", op: "create", id: "mb-read", seq: ++seq, updatedAt: RECENT,
      entity: profileOf("manual") }] as SyncChange[]);
    expect(consentPartition(store, opts).activity.get("typed@example.com")).toBe("dormant");
    // The organizer's rule is the act's: no person consented there, and a local rule cannot say otherwise.
    await store.applyChanges([
      { type: "mailbox_profile", op: "update", id: "mb-read", seq: ++seq, updatedAt: RECENT, entity: profileOf("promoted") },
      { type: "rule", op: "create", id: "local", seq: ++seq, updatedAt: RECENT,
        entity: rule({ id: "local", kind: "sender", match: "typed@example.com", destination: "INBOX", provenance: "manual" }) },
    ] as SyncChange[]);
    expect(consentPartition(store, opts).activity.get("typed@example.com")).toBe("active");
  });

  it("HISTORY IS NEVER UNREAD — over every mixture of age and read-state", async () => {
    const messages: EngineMessage[] = [];
    for (const [i, date] of [OLD, RECENT].entries()) {
      for (const [j, unread] of [true, false].entries()) {
        for (const [k, folder] of ["INBOX", "ohmail/Screener"].entries()) {
          messages.push(msg({ id: `m${i}${j}${k}`, from: `s${i}${j}${k}@example.com`, folder, date, unread }));
        }
      }
    }
    const part = consentPartition(await mirrorOf(messages), opts);

    expect(part.history.length).toBeGreaterThan(0);
    expect(part.history.every((m) => !m.unread)).toBe(true);
    // Only the old-and-read combinations survive into History.
    expect(part.history.map((m) => m.id).sort()).toEqual(["m010", "m011"]);
  });

  it("A DORMANT SENDER WHO WRITES AGAIN LEAVES HISTORY, AND BRINGS THEIR HISTORY WITH THEM", async () => {
    const backlog = [
      msg({ id: "old1", from: "friend@example.com", folder: "INBOX", date: OLD }),
      msg({ id: "old2", from: "friend@example.com", folder: "INBOX", date: OLD }),
    ];
    const before = consentPartition(await mirrorOf(backlog), opts);
    expect(before.history.map((m) => m.id).sort()).toEqual(["old1", "old2"]);
    expect(before.counts.activeUndecidedSenders).toBe(0);

    // They write. One new unread message re-opens the whole sender.
    const after = consentPartition(
      await mirrorOf([...backlog, msg({ id: "new1", from: "friend@example.com", folder: "ohmail/Screener", date: RECENT, unread: true })]),
      opts,
    );
    expect(after.history).toEqual([]);
    expect(after.counts.activeUndecidedSenders).toBe(1);

    // "As if new, with their history attached": the Screener row carries all three, not one.
    const seg = screenerSegments(presentationReader(await mirrorOf([...backlog, msg({ id: "new1", from: "friend@example.com", folder: "ohmail/Screener", date: RECENT, unread: true })]), after), NOW);
    expect(seg.waiting).toHaveLength(1);
    expect(seg.waiting[0]!.held.map((h) => h.id).sort()).toEqual(["new1", "old1", "old2"]);
  });

  it("the window is a dial, not a constant", async () => {
    const store = await mirrorOf([msg({ id: "x", from: "s@example.com", folder: "INBOX", date: "2026-06-01T09:00:00.000Z" })]);
    // 64 days before NOW: dormant at the default, active at a wider setting.
    expect(DEFAULT_DORMANCY_DAYS).toBe(60);
    expect(consentPartition(store, opts).history.map((m) => m.id)).toEqual(["x"]);
    expect(consentPartition(store, { ...opts, dormancyDays: 90 }).history).toEqual([]);
  });
});

/**
 * ═══ A MESSAGE WITH NO `Date:` HEADER IS DATED BY ITS ARRIVAL ═════════════════════════════
 *
 * `Date:` is written by the SENDER and the column is nullable, so any stranger can send mail the
 * cutline could not place in time. It answered "not recent", the sender went dormant, and mail
 * the phone had just filed at the gate presented under History — whose own explainer says
 * "haven't written in a while". Measured on a device: the engine's `/consent` counted that
 * sender active, the client counted it dormant, and the two lists were one sender apart.
 *
 * The rule is now the header ELSE the arrival (`arrivedAt`, the wire's `messages.created_at`),
 * which is the same coalesce the server's `cutlineInstant` makes — so the two implementations
 * read one instant. `all_time` is the second half: the client expressed it as `cutoff =
 * -Infinity`, still a COMPARISON, while the server's `activeSenderExpr` returns `true` and reads
 * no date at all — so the one setting that means "retire nobody" retired the undated sender.
 *
 * MUTATIONS WATCHED (each restored, `cmp`-proven): drop the `arrivedAt` arm from `messageMs`
 * ⇒ the first case RED; drop the `allTime` early return from `senderActivity` ⇒ the `all_time`
 * case RED on the row that carries no instant at all.
 *
 * The residual, stated because it is reachable: a mirror row from before the field carries
 * NEITHER fact, and under a window it still retires. Every server this engine talks to sends
 * the arrival, so the row heals on the next drain; `all_time` covers it meanwhile.
 */
describe("undated mail is dated by its arrival, never retired for want of a header", () => {
  /** Inside the 60-day window measured back from `NOW`, and the arrival the engine recorded. */
  const ARRIVED = "2026-07-28T11:20:00.000Z";

  it("A DATELESS MESSAGE THAT ARRIVED THIS WEEK KEEPS ITS SENDER AT THE GATE", async () => {
    const store = await mirrorOf([
      msg({ id: "nd1", from: "nodate@example.com", folder: "ohmail/Screener", date: null, arrivedAt: ARRIVED }),
    ]);

    expect(senderActivity(store.list<EngineMessage>("message"), opts).get("nodate@example.com")).toBe("active");
    const part = consentPartition(store, opts);
    // Not in History, and its place is the gate — the row the device run found in neither list.
    expect(part.history).toEqual([]);
    expect(part.placeOf.get("nd1")).toBe("ohmail/Screener");
    expect(part.counts.activeUndecidedSenders).toBe(1);
    expect(part.counts.dormantUndecidedSenders).toBe(0);
  });

  it("…and a dateless message that arrived YEARS ago still retires — the arrival is read, not ignored", async () => {
    // The other arm, so the fix cannot be "undated is always active", which would pin a sender
    // in the queue for ever on a header the sender controls.
    const store = await mirrorOf([
      msg({ id: "nd2", from: "ancient@example.com", folder: "ohmail/Screener", date: null, arrivedAt: OLD }),
    ]);

    expect(senderActivity(store.list<EngineMessage>("message"), opts).get("ancient@example.com")).toBe("dormant");
    expect(consentPartition(store, opts).history.map((m) => m.id)).toEqual(["nd2"]);
  });

  it("the HEADER still wins where there is one — the arrival is a fallback, not an override", async () => {
    // An old header with a fresh arrival (a backfill reaching further back) stays dormant: the
    // sender's own statement of when they wrote is the first fact, exactly as before.
    const store = await mirrorOf([
      msg({ id: "h1", from: "backfilled@example.com", folder: "INBOX", date: OLD, arrivedAt: ARRIVED }),
    ]);
    expect(senderActivity(store.list<EngineMessage>("message"), opts).get("backfilled@example.com")).toBe("dormant");
  });

  it("UNDER `all_time` NOBODY IS DORMANT — not even a row carrying no instant at all", async () => {
    // `all_time` is the account saying "screen everything". A mirror row written before
    // `arrivedAt` existed has neither fact, and under a cutoff comparison it retired anyway.
    const store = await mirrorOf([
      msg({ id: "at1", from: "noinstant@example.com", folder: "ohmail/Screener", date: null }),
      msg({ id: "at2", from: "old@example.com", folder: "ohmail/Screener", date: OLD }),
    ]);
    const part = consentPartition(store, { ...opts, screeningScope: "all_time" });

    expect(part.activity.get("noinstant@example.com")).toBe("active");
    expect(part.activity.get("old@example.com")).toBe("active");
    expect(part.history).toEqual([]);
    expect(part.counts.dormantUndecidedSenders).toBe(0);
    // And the mode is carried as a mode, which is what the server's predicate does.
    expect(cutlineFor({ ...opts, screeningScope: "all_time" }).allTime).toBe(true);
    expect(cutlineFor(opts).allTime).toBe(false);
  });
});

describe("consent decides the place, and nothing physical moves", () => {
  it("A CONSENTED SENDER'S RETIRED BACKLOG PRESENTS IN THE OHBOX WHILE STILL SITTING IN THE SCREENER FOLDER", async () => {
    // This is the case that makes the whole model affordable: a mailbox whose backlog was
    // already filed into the Screener folder does not need thousands of server moves to
    // start presenting correctly. A backfilled backlog is OLD AND READ, so the cutline has
    // retired the sender — which is why the gate rule in the case below leaves this one alone,
    // and why the server's own queue, which retires the same sender, agrees.
    const store = await mirrorOf(
      [
        msg({ id: "s1", from: "ben@example.com", folder: "ohmail/Screener", date: OLD }),
        msg({ id: "s2", from: "ben@example.com", folder: "ohmail/Screener", date: "2024-06-02T09:00:00.000Z" }),
      ],
      [rule({ id: "r1", kind: "sender", match: "ben@example.com", destination: "INBOX" })],
    );
    const part = consentPartition(store, opts);
    const presented = presentationReader(store, part);

    expect(part.activity.get("ben@example.com")).toBe("dormant");
    expect(part.history).toEqual([]);
    // INVERTED by ARCH-R902: the backlog stays at the gate until the server moves
    // it — its desired folder is on the wire the moment it is written. What this case defended
    // stands: no History, and a decided sender is not asked about again.
    expect(ohboxView(presented).previouslySeen.map((m) => m.id)).toEqual([]);
    expect(part.placeOf.get("s1")).toBe("ohmail/Screener");
    expect(screenerSegments(presented, NOW).waiting).toEqual([]);

    // …and the mirror still says where the mail actually is.
    expect(store.get<EngineMessage>("message", "s1")!.folder).toBe("ohmail/Screener");
    expect(physicalFolderOf(presented.get<EngineMessage>("message", "s1")!)).toBe("ohmail/Screener");
  });

  /**
   * ONE LETTER MOVED TO NEWS, THE REST OF THE SENDER'S MAIL WHERE THE MAILBOX HAS IT.
   * The Move press re-points the sender's rule and moves one letter; nothing moved the others, so
   * the Ohbox keeps them and News lists the one. Asked with the window known and before it is
   * (`rulesOnly`), which must answer the same (ARCH-R902 §4).
   */
  for (const rulesOnly of [false, true]) {
    it(`a News rule over INBOX mail it never moved leaves that mail in the Ohbox (rulesOnly=${rulesOnly})`, async () => {
      const S = "sender@example.com";
      const store = await mirrorOf(
        [
          msg({ id: "moved", from: S, folder: "ohmail/News", date: RECENT, unread: true }),
          msg({ id: "stays-1", from: S, folder: "INBOX", date: RECENT, unread: true }),
          msg({ id: "stays-2", from: S, folder: "INBOX", date: "2026-07-21T09:00:00.000Z", unread: true }),
          msg({ id: "stays-old", from: S, folder: "INBOX", date: OLD, unread: false }),
        ],
        [rule({ id: "r1", kind: "sender", match: S, destination: "ohmail/News" })],
      );
      const part = consentPartition(store, { ...opts, rulesOnly });
      const presented = presentationReader(store, part);

      expect(["moved", "stays-1", "stays-2", "stays-old"].map((id) => part.placeOf.get(id)))
        .toEqual(["ohmail/News", "INBOX", "INBOX", "INBOX"]);
      expect(part.history).toEqual([]);
      expect(part.counts.activeUndecidedSenders).toBe(0);
      expect(ohboxView(presented).newForYou.map((m) => m.id).sort()).toEqual(["stays-1", "stays-2"]);
      const news = readsPartition(presented);
      expect([...news.fresh, ...news.seen].map((m) => m.id)).toEqual(["moved"]);
    });
  }

  /**
   * MEASURED on a real mailbox (phone rig, 2026-09-11): NINE senders physically in
   * `ohmail/Screener`, FIVE of them carrying an enabled sender rule to a consenting destination
   * written weeks BEFORE the mail arrived — the rule exists, the mail is still held, the server
   * still asks about all nine, and the client showed FOUR. `GET /screener` derives its queue from
   * held mail and consults no rules at all (`screener-service.ts#heldSenderPage`), so a client
   * that projects held mail to the rule's destination answers a different question and shows the
   * narrower answer as the mailbox's own count. The same call serves the webapp shell and, through
   * it, the desktop.
   */
  it("A RULE THAT HAS NOT MOVED THE MAIL CHANGES NOTHING — active gate-held mail waits AT THE GATE", async () => {
    const store = await mirrorOf(
      [msg({ id: "g1", from: "ruled@example.com", folder: "ohmail/Screener", date: RECENT })],
      [rule({ id: "r1", kind: "sender", match: "ruled@example.com", destination: "INBOX" })],
    );
    const part = consentPartition(store, opts);
    const presented = presentationReader(store, part);

    expect(part.placeOf.get("g1")).toBe("ohmail/Screener");
    const waiting = screenerSegments(presented, NOW).waiting;
    expect(waiting.map((w) => w.from.address)).toEqual(["ruled@example.com"]);
    // The row is DECIDABLE, not decorative: its representative is the gate-physical message, so
    // the press is a decide the gate can resolve rather than a rule routed past it.
    expect(waiting[0]!.gatePhysical).toBe(true);
    // One list, not two. The mail is at the gate, so it is not also in the Ohbox, and a rule
    // pointing somewhere else never put it in History either.
    expect(ohboxView(presented).previouslySeen.map((m) => m.id)).toEqual([]);
    expect(part.history).toEqual([]);
    // Nothing physical moved — this is a presentation, exactly like every other case here.
    expect(physicalFolderOf(presented.get<EngineMessage>("message", "g1")!)).toBe("ohmail/Screener");
  });

  it("mail the gate is NOT holding stays where the mailbox has it — one sender, two residences", async () => {
    // INVERTED by ARCH-R902: this pinned the INBOX letter at the rule's
    // destination; a rule that has not moved it changes nothing a person sees.
    const store = await mirrorOf(
      [
        msg({ id: "gate", from: "ruled@example.com", folder: "ohmail/Screener", date: RECENT }),
        msg({ id: "inbox", from: "ruled@example.com", folder: "INBOX", date: "2026-07-25T09:00:00.000Z" }),
      ],
      [rule({ id: "r1", kind: "sender", match: "ruled@example.com", destination: "ohmail/News" })],
    );
    const part = consentPartition(store, opts);

    expect(part.placeOf.get("gate")).toBe("ohmail/Screener");
    expect(part.placeOf.get("inbox")).toBe("INBOX");
    // The waiting row carries the HELD mail only — the bag a decide can act on.
    expect(screenerSegments(presentationReader(store, part), NOW).waiting.map((w) => w.held.map((h) => h.id)))
      .toEqual([["gate"]]);
  });

  it("the COUNTS stay the cutline's own question — a ruled sender is DECIDED on both sides", async () => {
    // `cutlineCounts` classifies a sender with a rule as decided wherever their mail sits, and
    // `consent-cutline.pg.test.ts` pins the client's counts to that SQL. The PLACE moved here;
    // the count may not, or the two implementations disagree by one on every ruled held sender.
    const store = await mirrorOf(
      [
        msg({ id: "g1", from: "ruled@example.com", folder: "ohmail/Screener", date: RECENT }),
        msg({ id: "u1", from: "stranger@example.com", folder: "ohmail/Screener", date: RECENT }),
      ],
      [rule({ id: "r1", kind: "sender", match: "ruled@example.com", destination: "INBOX" })],
    );
    const part = consentPartition(store, opts);

    expect(part.counts.activeUndecidedSenders).toBe(1);
    expect(part.counts.dormantUndecidedSenders).toBe(0);
    // …and BOTH are on the shelf, which is the whole difference between the queue and the count.
    expect(screenerSegments(presentationReader(store, part), NOW).waiting).toHaveLength(2);
  });

  it("an address rule beats a domain rule, and a disabled rule is not consent", async () => {
    const store = await mirrorOf(
      [
        msg({ id: "d1", from: "ok@corp.example", folder: "INBOX", date: OLD }),
        msg({ id: "d2", from: "hushed@corp.example", folder: "INBOX", date: OLD }),
        msg({ id: "d3", from: "off@other.example", folder: "INBOX", date: OLD }),
      ],
      [
        rule({ id: "r1", kind: "domain", match: "corp.example", destination: "INBOX" }),
        rule({ id: "r2", kind: "sender", match: "hushed@corp.example", destination: "ohmail/Screened" }),
        rule({ id: "r3", kind: "sender", match: "off@other.example", destination: "INBOX", enabled: false }),
      ],
    );
    const part = consentPartition(store, opts);

    expect(part.placeOf.get("d1")).toBe("INBOX");
    expect(part.placeOf.get("d2")).toBe("ohmail/Screened");
    // The disabled rule grants nothing, so this sender is simply undecided — and dormant.
    expect(part.placeOf.get("d3")).toBe(null);
    expect(part.history.map((m) => m.id)).toEqual(["d3"]);
  });

  it("A RULE POINTING AT THE SCREENER IS NOT A DECISION", async () => {
    // Such a rule is representable and says "hold this sender at the gate" — the absence of a
    // decision, written down. Read as a decision it would exempt the sender from the cutline
    // and park somebody nobody has answered for in the queue for ever.
    const store = await mirrorOf(
      [msg({ id: "g1", from: "gate@example.com", folder: "INBOX", date: OLD })],
      [rule({ id: "r1", kind: "sender", match: "gate@example.com", destination: "ohmail/Screener" })],
    );
    const part = consentPartition(store, opts);

    expect(part.placeOf.get("g1")).toBe(null);
    expect(part.history.map((m) => m.id)).toEqual(["g1"]);
    expect(part.counts.consentedSenders).toBe(0);
  });

  it("AN EXPLICIT PLACEMENT IS ALREADY AN ANSWER and is never re-placed", async () => {
    const store = await mirrorOf([
      msg({ id: "p1", from: "nobody@example.com", folder: "ohmail/News", date: OLD }),
      msg({ id: "p2", from: "nobody@example.com", folder: "ohmail/Receipts", date: OLD }),
      msg({ id: "p3", from: "nobody@example.com", folder: "ohmail/Screened", date: OLD }),
      msg({ id: "p4", from: "nobody@example.com", folder: "ohmail/Quarantine", date: OLD }),
    ]);
    const part = consentPartition(store, opts);

    expect(part.history).toEqual([]);
    expect(part.placeOf.get("p1")).toBe("ohmail/News");
    expect(part.placeOf.get("p3")).toBe("ohmail/Screened");
  });

  it("THE USER IS NOT ONE OF THEIR OWN CORRESPONDENTS, even in the INBOX", async () => {
    // Sent-folder mail is already ignored for being outside the presented set, so this is the
    // case that needs saying: mail somebody sends to themselves lands in the INBOX, and without
    // an explicit exclusion the user turns up in their own Screener queue — which a live account
    // showed.
    const store = await mirrorOf([
      msg({ id: "self1", from: "me@example.com", folder: "INBOX", date: RECENT, unread: true }),
      msg({ id: "self2", from: "me@example.com", folder: "INBOX", date: OLD }),
    ]);
    const part = consentPartition(store, { ...opts, ownAddresses: ["Me@Example.com"] });

    expect(part.counts.activeUndecidedSenders).toBe(0);
    expect(part.counts.dormantUndecidedSenders).toBe(0);
    expect(part.history).toEqual([]);
    // Their own mail keeps the place it is in — it is not homeless, it is theirs.
    expect(part.placeOf.get("self2")).toBe("INBOX");
  });

  /**
   * SENT MAIL IS NEVER A SCREENER CANDIDATE — and it IS subject to the date half of the cutline.
   *
   * The first half is permanent: a decision about oneself is meaningless, so the user's own mail
   * can never queue for consent and can never make anybody active. That is unchanged and is what
   * the Screener and the sender-count assertions below pin.
   *
   * The second half is a CORRECTION to what this test used to assert. It read
   * `expect(part.history).toEqual([])` over two messages dated 2024 — the claim being that
   * outbound mail has no place at all in the model, so the cutline never touches it. On a real
   * mailbox that means every message the account has ever sent presents in "Earlier", which is
   * the arrival state the baseline exists to refuse; it just wears a different label when the
   * backlog is outbound. There is no sender to weigh, so the cutline reduces to its date half,
   * and the answer is the same one inbound mail gets: written before the line ⇒ History.
   */
  it("SENT MAIL IS NEVER A SCREENER CANDIDATE — and the cutline still decides which side it is on", async () => {
    const store = await mirrorOf([
      msg({ id: "sent-old", from: "me@example.com", folder: "Sent Messages", date: OLD }),
      msg({ id: "sent-recent", from: "me@example.com", folder: "INBOX/Sent", date: RECENT }),
    ]);
    const part = consentPartition(store, opts);
    const presented = presentationReader(store, part);

    // Never a decision to make about yourself — and never a sender in either count.
    expect(screenerSegments(presented, NOW).waiting).toEqual([]);
    expect(part.counts.activeUndecidedSenders).toBe(0);
    expect(part.counts.dormantUndecidedSenders).toBe(0);

    // Beyond the line ⇒ History, exactly as a dormant stranger's read mail is.
    expect(part.history.map((m) => m.id)).toEqual(["sent-old"]);
    // Inside it ⇒ the Ohbox's "Earlier", so a conversation reads with both sides present. It
    // lands read (`\Seen` at ingest) and never in "New for you".
    expect(ohboxView(presented).newForYou).toEqual([]);
    expect(ohboxView(presented).previouslySeen.map((m) => m.id)).toEqual(["sent-recent"]);
  });
});

/**
 * ═══ #116 — A SCREEN-IN RULE FROM PAST THE GATE LANDS THE SENDER IN THE OHBOX ═══════════
 *
 * The mechanism the client-only fix leans on. A sender bulk-moved Screener→INBOX is active and
 * undecided, so their INBOX mail presents in the Screener. The past-the-gate ladder writes a
 * `rule_create` pointing at INBOX; once that rule is in the mirror, the DECIDED branch of
 * `consentPartition` places every one of their messages at INBOX, and the whole bag appears in the
 * Ohbox — with nothing moved on the server. This is a pure-cutline guard on that round-trip.
 */
describe("#116 — the INBOX rule flips the sender from the Screener to the Ohbox", () => {
  const inbox = [
    msg({ id: "c1", from: personalAt("fixture.mila", "gmail.com"), folder: "INBOX", date: RECENT, unread: true }),
    msg({ id: "c2", from: personalAt("fixture.mila", "gmail.com"), folder: "INBOX", date: RECENT, unread: true }),
  ];

  it("before the rule they present in the Screener; after it, in the Ohbox — nothing moved", async () => {
    // BEFORE: active + undecided + INBOX ⇒ presented at the gate, absent from the Ohbox.
    const before = await mirrorOf(inbox);
    const beforePart = consentPartition(before, opts);
    expect(beforePart.placeOf.get("c1")).toBe("ohmail/Screener");
    expect(ohboxView(presentationReader(before, beforePart)).newForYou).toEqual([]);

    // AFTER: the same mail plus the rule the ladder writes (destination INBOX).
    const after = await mirrorOf(inbox, [
      rule({ id: "r-in", kind: "sender", match: personalAt("fixture.mila", "gmail.com"), destination: "INBOX", provenance: "manual" }),
    ]);
    const part = consentPartition(after, opts);

    // THE GUARD. Skip the `decided !== null` branch in `consentPartition` and this goes red: the
    // sender falls back to active-undecided and their mail presents in the Screener again — which
    // is the vanish this whole fix removes.
    expect(part.placeOf.get("c1")).toBe("INBOX");
    expect(part.placeOf.get("c2")).toBe("INBOX");

    const presented = presentationReader(after, part);
    expect(ohboxView(presented).newForYou.map((m) => m.id).sort()).toEqual(["c1", "c2"]);
    // …and the queue no longer holds them: the decision has been made.
    expect(screenerSegments(presented, NOW).waiting).toEqual([]);

    // Nothing physical moved — the mail is still in the INBOX, exactly where the bulk move left it.
    expect(after.get<EngineMessage>("message", "c1")!.folder).toBe("INBOX");
    expect(after.get<EngineMessage>("message", "c2")!.folder).toBe("INBOX");
  });
});

describe("a thread does not fragment across the Ohbox and History", () => {
  const thread = [
    msg({ id: "t1", from: "ben@example.com", folder: "INBOX", date: OLD, threadId: "th" }),
    msg({ id: "t2", from: "stranger@example.com", folder: "INBOX", date: OLD, threadId: "th" }),
    msg({ id: "t3", from: "stranger@example.com", folder: "INBOX", date: OLD, threadId: "other" }),
  ];

  /**
   * The rescue needs the account's OWN outbound on the thread to name the sender. `threadId` is
   * the header chain, and In-Reply-To/References are the sender's own writing — so without that
   * record a stranger who names a Message-ID this mailbox holds would be carried out of the
   * Screener's reach and into the consented pile by a header they wrote themselves.
   */
  const ourReply = msg({
    id: "mine", from: "me@example.com", folder: "Sent", date: OLD, threadId: "th",
    to: ["ben@example.com", "stranger@example.com"],
  });

  it("the thread presents where its consented mail lives", async () => {
    const store = await mirrorOf([...thread, ourReply], [rule({ id: "r1", kind: "sender", match: "ben@example.com", destination: "INBOX" })]);
    const part = consentPartition(store, opts);

    // t2 would be History on its own account — its sender is undecided and dormant — but it
    // is on a thread the user has consented to AND written on, so it follows the thread.
    expect(part.placeOf.get("t2")).toBe("INBOX");
    // The same sender's OTHER thread has no consented mail on it and stays in History.
    expect(part.history.map((m) => m.id)).toEqual(["t3"]);
  });

  it("A HEADER IS NOT AN ADMISSION — unanswered, the stranger's row stays in History", async () => {
    // The same mirror without our own reply: every other condition for the rescue holds, and
    // the only thing joining the stranger to the consented conversation is the thread the
    // header chain put them on.
    const store = await mirrorOf(thread, [rule({ id: "r1", kind: "sender", match: "ben@example.com", destination: "INBOX" })]);
    const part = consentPartition(store, opts);

    expect(part.placeOf.get("t2")).toBe(null);
    expect(part.history.map((m) => m.id).sort()).toEqual(["t2", "t3"]);
  });

  it("our own sent row is rescued to its own folder without any such record — it is our writing", async () => {
    // The own-sent branch of the rescue: outbound mail is nobody's admission, so it leaves
    // History whether or not the account ever addressed itself.
    const store = await mirrorOf(
      [
        msg({ id: "t1", from: "ben@example.com", folder: "INBOX", date: OLD, threadId: "th" }),
        msg({ id: "own", from: "me@example.com", folder: "Sent", date: OLD, threadId: "th" }),
      ],
      [rule({ id: "r1", kind: "sender", match: "ben@example.com", destination: "INBOX" })],
    );
    const part = consentPartition(store, opts);

    expect(part.placeOf.get("own")).toBe("Sent");
    expect(part.history.map((m) => m.id)).toEqual([]);
  });

  it("without the consented participant, the whole thread is History", async () => {
    const part = consentPartition(await mirrorOf(thread), opts);
    expect(part.history.map((m) => m.id).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("THE RULE DOES NOT RESCUE SCREENER ROWS — an active sender still owes a decision", async () => {
    // Deliberate boundary. The Screener is a per-sender queue, not a place; a sender who once
    // replied on a consented thread must not silently skip the decision it exists to ask for.
    //
    // `loud@`'s mail is at the GATE rather than in the INBOX, which is where a backfilled mailbox
    // actually holds an unscreened stranger's mail — and it is load-bearing for the third
    // assertion rather than incidental. See the test below it: a waiting ROW can only be minted on
    // a gate-physical message, because that is the only kind `POST /screener/:id` resolves. With
    // `c2` in the INBOX this used to assert a row that rendered every control and performed none
    // of them, which is a claim about `screenerSegments` this test never meant to make.
    const store = await mirrorOf(
      [
        msg({ id: "c1", from: "ben@example.com", folder: "INBOX", date: OLD, threadId: "th" }),
        msg({ id: "c2", from: "loud@example.com", folder: "ohmail/Screener", date: RECENT, unread: true, threadId: "th" }),
      ],
      [rule({ id: "r1", kind: "sender", match: "ben@example.com", destination: "INBOX" })],
    );
    const part = consentPartition(store, opts);

    // The thread rule leaves them exactly where the cutline put them. This is the subject.
    expect(part.placeOf.get("c2")).toBe("ohmail/Screener");
    expect(part.counts.activeUndecidedSenders).toBe(1);
    expect(screenerSegments(presentationReader(store, part), NOW).waiting).toHaveLength(1);
  });

  /**
   * A WAITING ROW PREFERS A GATE-PHYSICAL ID, AND MARKS ITSELF WHEN IT HAS NONE (#116).
   *
   * `POST /screener/:id` resolves only rows whose `desired_folder` is `ohmail/Screener`
   * (`screener-service.ts` — `heldRowById` inherits the predicate from `heldRows`), and
   * `derivedScreenerEffects` refuses locally on the same condition. So a decide on an INBOX
   * representative is a 404 on the wire AND a silent no-op in the mirror.
   *
   * That is reachable because the Screener reads a PROJECTED mirror: the partition presents an
   * active undecided sender's INBOX mail at the gate, so it joins the waiting bucket. The rep is
   * therefore the sender's newest GATE-PHYSICAL mail when they have any. When they have NONE — the
   * bulk-moved shape #116 is about — the row is STILL minted (`newestFirst[0]`) and marked
   * `gatePhysical:false`, which is the switch the commit path reads to route the decision past the
   * gate as a rule rather than a dead decide. Suppressing the row (the old behaviour) left the
   * sender reachable only by search — the vanish.
   *
   * Mutation watched: dropping the `?? newestFirst[0]` fallback makes the INBOX-only case mint no
   * row at all; taking the rep from `newestFirst[0]` unconditionally makes the mixed case report
   * `p-inbox` and mark itself gate-physical when it is not.
   */
  it("a waiting row prefers gate-physical mail, and is marked when it has none", async () => {
    // Mixed residence: the newest message is in the INBOX, the older one is at the gate.
    const mixed = await mirrorOf([
      msg({ id: "p-gate", from: "both@example.com", folder: "ohmail/Screener", date: OLD }),
      msg({ id: "p-inbox", from: "both@example.com", folder: "INBOX", date: RECENT, unread: true }),
    ]);
    const mixedPart = consentPartition(mixed, opts);
    const mixedWaiting = screenerSegments(presentationReader(mixed, mixedPart), NOW).waiting;
    expect(mixedWaiting).toHaveLength(1);
    // The id is the gate message, not the newer INBOX one a naive "newest wins" would pick.
    expect(mixedWaiting[0]!.id).toBe("p-gate");
    expect(mixedWaiting[0]!.gatePhysical).toBe(true);
    // The row still speaks for the sender's whole bag — the INBOX message is previewable.
    expect(mixedWaiting[0]!.held.map((h) => h.id).sort()).toEqual(["p-gate", "p-inbox"]);

    // INBOX only: the partition presents them at the gate, and there is no id the gate would
    // accept — but the row is minted anyway, marked NOT gate-physical, so the commit can route it
    // past the gate instead of vanishing it. This is the #116 fix.
    const inboxOnly = await mirrorOf([
      msg({ id: "q1", from: "only@example.com", folder: "INBOX", date: RECENT, unread: true }),
    ]);
    const inboxPart = consentPartition(inboxOnly, opts);
    expect(inboxPart.placeOf.get("q1")).toBe("ohmail/Screener");
    expect(inboxPart.counts.activeUndecidedSenders).toBe(1);
    const inboxWaiting = screenerSegments(presentationReader(inboxOnly, inboxPart), NOW).waiting;
    expect(inboxWaiting).toHaveLength(1);
    expect(inboxWaiting[0]!.id).toBe("q1");
    expect(inboxWaiting[0]!.gatePhysical).toBe(false);
    expect(inboxWaiting[0]!.held.map((h) => h.id)).toEqual(["q1"]);
  });
});

describe("the presentation reader", () => {
  it("hides History mail from the piles without touching the mirror", async () => {
    const store = await mirrorOf([msg({ id: "h1", from: "quiet@example.com", folder: "INBOX", date: OLD })]);
    const part = consentPartition(store, opts);
    const presented = presentationReader(store, part);

    expect(presented.list<EngineMessage>("message")).toEqual([]);
    expect(presented.get<EngineMessage>("message", "h1")).toBeUndefined();
    expect(presented.entries<EngineMessage>("message")).toEqual([]);
    // The mirror is untouched — History mail is still openable, searchable and read from here.
    expect(store.list<EngineMessage>("message")).toHaveLength(1);
    expect(historyView(part).map((m) => m.id)).toEqual(["h1"]);
  });

  it("passes every other entity type through unchanged", async () => {
    const store = await mirrorOf([msg({ id: "h1", from: "q@example.com", folder: "INBOX", date: OLD })], [rule({ id: "r1", kind: "sender", match: "x@example.com", destination: "INBOX" })]);
    const presented = presentationReader(store, consentPartition(store, opts));
    expect(presented.list<RuleDTO>("rule")).toHaveLength(1);
    expect(presented.version()).toBe(store.version());
  });
});

/**
 * THE SCREENING BASELINE (mail 0056) — what changes once an account has decided something.
 *
 * Without a baseline the cutoff is `now - dormancyDays` and unread outranks age, which is the
 * pair of properties every test above pins. Both of them move on their own: the window slides,
 * and OLD UNREAD MAIL KEEPS ARRIVING — a backfill pass reaching further back, a folder read for
 * the first time, a `\Seen` flag adopted late. So a sender the account worked past months ago
 * reappears in the queue and then vanishes again, which is the churn this baseline removes.
 */
describe("the screening baseline", () => {
  /** `BASELINE - 60d` is 2026-06-05, so `OLD` is far behind it and `RECENT` is ahead of it. */
  const BASELINE = new Date("2026-08-04T00:00:00.000Z");
  const baselined = { now: NOW, baselineAt: BASELINE };
  /** 150 days before `NOW`: outside the 60-day window by a wide margin. */
  const OLD_150 = new Date(NOW.getTime() - 150 * 24 * 60 * 60 * 1000).toISOString();

  it("A 150-DAY-OLD UNREAD UNDECIDED SENDER WAITS TODAY, AND IS HISTORY UNDER A BASELINE", async () => {
    const build = () => mirrorOf([
      msg({ id: "a1", from: "resurrected@example.com", folder: "ohmail/Screener", date: OLD_150, unread: true }),
    ]);

    // TODAY: unread outranks age, so this sender is in the waiting queue.
    const before = consentPartition(await build(), { now: NOW });
    expect(before.activity.get("resurrected@example.com")).toBe("active");
    expect(before.counts.activeUndecidedSenders).toBe(1);
    expect(before.history).toHaveLength(0);

    // UNDER A BASELINE: the message is pre-cutoff, so it cannot resurrect the sender by any
    // route — including unread. It presents in History.
    const after = consentPartition(await build(), baselined);
    expect(after.activity.get("resurrected@example.com")).toBe("dormant");
    expect(after.counts.activeUndecidedSenders).toBe(0);
    expect(after.history.map((m) => m.id)).toEqual(["a1"]);
    // …and History now holds UNREAD mail, which is exactly what the badge note at the top of
    // `consent-cutline.ts` had to be rewritten for. Asserted rather than left implied, because
    // the old header claimed this was impossible by construction.
    expect(after.history[0]!.unread).toBe(true);
  });

  it("A POST-BASELINE STRANGER NEVER GOES DORMANT — the cutoff stops sliding", async () => {
    // Mail from the day after the baseline. Under the sliding window it ages out unanswered; with
    // a baseline it is newer than the cutoff for ever and waits until somebody decides.
    const justAfter = new Date(BASELINE.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const build = () => mirrorOf([
      msg({ id: "n1", from: "newcomer@example.com", folder: "ohmail/Screener", date: justAfter, unread: false }),
    ]);
    const muchLater = new Date(BASELINE.getTime() + 400 * 24 * 60 * 60 * 1000);

    expect(consentPartition(await build(), { now: muchLater })
      .activity.get("newcomer@example.com")).toBe("dormant");
    expect(consentPartition(await build(), { now: muchLater, baselineAt: BASELINE })
      .activity.get("newcomer@example.com")).toBe("active");
  });

  it("DECIDED STAYS DECIDED — a baseline never touches a sender with a rule", async () => {
    const store = await mirrorOf(
      [msg({ id: "d1", from: "known@example.com", folder: "ohmail/Screener", date: OLD_150, unread: true })],
      [rule({ id: "r1", kind: "sender", match: "known@example.com", destination: "INBOX" })],
    );
    const part = consentPartition(store, baselined);
    // Never in History, whatever the cutline thinks of the date; and, INVERTED by ARCH-R902, at
    // the gate where it sits rather than at the rule's destination.
    expect(part.placeOf.get("d1")).toBe("ohmail/Screener");
    expect(part.history).toHaveLength(0);
    expect(part.counts.consentedSenders).toBe(1);
  });

  it("A LETTER HELD AT THE GATE IS DATED BY ITS ARRIVAL: an old header that arrived now waits, read or unread", async () => {
    const arrived = new Date(BASELINE.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const part = consentPartition(await mirrorOf([
      msg({ id: "u1", from: "udo@example.com", folder: "ohmail/Screener", date: OLD_150, sortAt: arrived, unread: true }),
      msg({ id: "o1", from: "olga@example.com", folder: "ohmail/Screener", date: OLD_150, sortAt: arrived, unread: false }),
    ]), baselined);
    expect(part.activity.get("udo@example.com")).toBe("active");
    expect(part.activity.get("olga@example.com")).toBe("active");
    expect(part.placeOf.get("u1")).toBe("ohmail/Screener");
    expect(part.placeOf.get("o1")).toBe("ohmail/Screener");
    expect(part.counts.activeUndecidedSenders).toBe(2);
    expect(part.history).toHaveLength(0);
  });

  it("…but a letter the server received before the window is History, read or unread", async () => {
    const part = consentPartition(await mirrorOf([
      msg({ id: "u1", from: "udo@example.com", folder: "ohmail/Screener", date: OLD_150, sortAt: OLD_150, unread: true }),
      msg({ id: "o1", from: "olga@example.com", folder: "ohmail/Screener", date: OLD_150, sortAt: OLD_150, unread: false }),
    ]), baselined);
    expect(part.activity.get("udo@example.com")).toBe("dormant");
    expect(part.activity.get("olga@example.com")).toBe("dormant");
    expect(part.counts.activeUndecidedSenders).toBe(0);
    expect(part.history.map((m) => m.id).sort()).toEqual(["o1", "u1"]);
  });

  it("…and a letter the mailbox's first import recorded is History, as for a held claim", async () => {
    const day = 24 * 60 * 60 * 1000;
    const arrived = new Date(BASELINE.getTime() + day).toISOString();
    const done = new Date(BASELINE.getTime() + 2 * day).toISOString();
    const later = new Date(BASELINE.getTime() + 3 * day).toISOString();
    const store = await mirrorOf([
      msg({ id: "p1", from: "imported@example.com", folder: "ohmail/Screener", date: OLD_150, sortAt: arrived, arrivedAt: arrived }),
      msg({ id: "p2", from: "after@example.com", folder: "ohmail/Screener", date: OLD_150, sortAt: later, arrivedAt: later }),
    ]);
    const finished = consentPartition(store, { ...baselined, firstImportDoneAt: { mb: done } });
    expect(finished.activity.get("imported@example.com")).toBe("dormant");
    expect(finished.activity.get("after@example.com")).toBe("active");
    expect(finished.history.map((m) => m.id)).toEqual(["p1"]);
    // Still importing: nothing it records waits by its arrival.
    const importing = consentPartition(store, { ...baselined, firstImportDoneAt: { mb: null } });
    expect(importing.counts.activeUndecidedSenders).toBe(0);
  });

  it("the arrival clock reads only held mail of undecided senders", async () => {
    const arrived = new Date(BASELINE.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const part = consentPartition(await mirrorOf([
      msg({ id: "d1", from: "known@example.com", folder: "ohmail/Screener", date: OLD_150, sortAt: arrived }),
      msg({ id: "i1", from: "inboxed@example.com", folder: "INBOX", date: OLD_150, sortAt: arrived }),
    ], [rule({ id: "r1", kind: "sender", match: "known@example.com", destination: "INBOX" })]), baselined);
    // A decided sender is retired at the gate as before, never queued again by it.
    expect(part.activity.get("known@example.com")).toBe("dormant");
    expect(part.placeOf.get("d1")).toBe("ohmail/Screener");
    expect(part.retiredDecided.has("known@example.com")).toBe(true);
    // A letter in the INBOX keeps today's answer: History.
    expect(part.activity.get("inboxed@example.com")).toBe("dormant");
    expect(part.history.map((m) => m.id)).toEqual(["i1"]);
    expect(part.counts.activeUndecidedSenders).toBe(0);
  });

  it("A NULL OR ABSENT BASELINE IS EXACTLY TODAY'S BEHAVIOUR", async () => {
    // The dangerous-default rule. If the narrowing were folded into a `?? now()` default rather
    // than gated on the baseline being PRESENT, this is what would go red — and on a live account
    // it is every undecided sender with old unread mail leaving the queue on deploy.
    const build = () => mirrorOf([
      msg({ id: "a1", from: "stale@example.com", folder: "ohmail/Screener", date: OLD_150, unread: true }),
    ]);
    for (const o of [{ now: NOW }, { now: NOW, baselineAt: null }] as const) {
      const part = consentPartition(await build(), o);
      expect(part.activity.get("stale@example.com")).toBe("active");
      expect(part.counts.activeUndecidedSenders).toBe(1);
      expect(part.history).toHaveLength(0);
    }
  });

  it("AN UNPARSEABLE BASELINE READS AS ABSENT, never as epoch 0", async () => {
    // A 1970 baseline would put every message after the cutoff and pin every undecided sender in
    // the queue for ever — the loudest failure available for a value nobody can see.
    const store = await mirrorOf([
      msg({ id: "a1", from: "stale@example.com", folder: "ohmail/Screener", date: OLD_150, unread: true }),
      msg({ id: "b1", from: "quiet@example.com", folder: "ohmail/Screener", date: OLD_150, unread: false }),
    ]);
    const part = consentPartition(store, { now: NOW, baselineAt: "not a date" });
    // Absent-baseline behaviour: unread wins, read-and-old is dormant.
    expect(part.activity.get("stale@example.com")).toBe("active");
    expect(part.activity.get("quiet@example.com")).toBe("dormant");
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════
     "ALL TIME" ON THE CLIENT (mail 0083)

     The server's router has honoured `screening_scope = 'all_time'` since the column landed —
     `resolveScreeningCutoff` answers `undefined`, "hold every unruled sender's mail whatever its
     date". This side had no branch at all, and the Screener queue and the History placement are
     built from THIS partition: on a standalone install, where there is no hosted router in front
     of the reader, the mode was written to the database and never read by anything the person
     could see. A control that reports success and changes nothing.

     `-Infinity` is how "no cutoff" is spelled here, because `cutoff` is a number both halves
     compare against rather than something that can be absent.
     ══════════════════════════════════════════════════════════════════════════════════════ */

  it("all time removes the cutoff entirely, and beats a baseline that is present", () => {
    expect(cutlineFor({ now: NOW, screeningScope: "all_time" }))
      .toEqual({ cutoff: -Infinity, baselined: false, allTime: true });
    // ABOVE the baseline read, mirroring the server. The other order would make the mode inert
    // for every account that has ever screened anything — which is every account it is offered to.
    expect(cutlineFor({ now: NOW, baselineAt: BASELINE, dormancyDays: 5, screeningScope: "all_time" }))
      .toEqual({ cutoff: -Infinity, baselined: true, allTime: true });
  });

  it("an unrecognised scope is the WINDOW, never the wider mode", () => {
    const day = 24 * 60 * 60 * 1000;
    // The direction a bad stored value must fail in: screening everything is a lot of moved mail
    // to undo by hand. `undefined`, `null` and a typo all read as the window.
    for (const bad of [undefined, null, "window", "ALL_TIME", "all time", ""]) {
      expect(cutlineFor({ now: NOW, baselineAt: BASELINE, screeningScope: bad }), String(bad))
        .toEqual({ cutoff: BASELINE.getTime() - DEFAULT_DORMANCY_DAYS * day, baselined: true, allTime: false });
    }
  });

  it("all time makes an old, read, undecided sender ACTIVE — the queue grows, nothing moves", async () => {
    const store = await mirrorOf([
      msg({ id: "a1", from: "quiet@example.com", folder: "ohmail/Screener", date: OLD_150, unread: false }),
    ]);
    // Under the window this sender is dormant and sits in History — the state the feedback was
    // about ("only 365 days").
    const windowed = consentPartition(store, { now: NOW, baselineAt: BASELINE });
    expect(windowed.activity.get("quiet@example.com")).toBe("dormant");

    // Under all time they are active and waiting for a decision. THE MAIL HAS NOT MOVED: the
    // message is still in the same folder, and History no longer claims it. That is the copy's
    // claim ("their mail stays where it is") asserted rather than promised.
    const wide = consentPartition(store, {
      now: NOW, baselineAt: BASELINE, screeningScope: "all_time",
    });
    expect(wide.activity.get("quiet@example.com")).toBe("active");
    expect([...wide.history]).toEqual([]);
  });

  it("`cutlineFor` states the arithmetic once, for both halves of the product", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(cutlineFor({ now: NOW })).toEqual({
      cutoff: NOW.getTime() - DEFAULT_DORMANCY_DAYS * day, baselined: false, allTime: false,
    });
    expect(cutlineFor({ now: NOW, baselineAt: BASELINE })).toEqual({
      cutoff: BASELINE.getTime() - DEFAULT_DORMANCY_DAYS * day, baselined: true, allTime: false,
    });
    expect(cutlineFor({ now: NOW, baselineAt: BASELINE, dormancyDays: 5 })).toEqual({
      cutoff: BASELINE.getTime() - 5 * day, baselined: true, allTime: false,
    });
  });
});

/**
 * A RESURFACED ROW IS NEVER THE CUTLINE'S TO PLACE — the orphan guard, measured before written.
 *
 * On a live mailbox, a message snoozed for yesterday came due and vanished: the flip took it out
 * of the Resurface pile (`resurfaced` is no pile), and the partition — weighing it by its SENDER
 * like any other undecided-residence mail — presented it in the Screener (active) or deleted it
 * from the projected list entirely (History, dormant). The Ohbox's pinned group, the state's only
 * home, never saw it. Reachable by search, filed in NO list.
 *
 * The invariant these encode: a resurfaced row is presented, in place, whatever its sender's
 * standing — so `ohboxView` over the PROJECTED reader pins it, exactly once. Mutations that
 * delete the exemption in `consentPartition` (the row goes back to History/Screener) or re-scope
 * `ohboxView`'s pin to the INBOX slice go red here.
 */
describe("resurfaced rows and the cutline — the pin outranks the sender's standing", () => {
  const resurfacedState = (id: string) =>
    ({ messageId: id, state: "resurfaced", bubbleUpAt: null, setAt: RECENT, updatedAt: RECENT }) as unknown as EngineMessage["triage"];

  it("a DORMANT undecided sender's resurfaced row presents in place — never deleted into History", async () => {
    const pinned = { ...msg({ id: "pin1", from: "dormant@example.com", folder: "INBOX", date: OLD, unread: false }), triage: resurfacedState("pin1") };
    const store = await mirrorOf([
      pinned,
      msg({ id: "old1", from: "dormant@example.com", folder: "INBOX", date: OLD, unread: false }),
    ]);
    const part = consentPartition(store, opts);

    // The sender's OTHER mail still rests in History; the pinned row does not follow them there.
    expect(part.history.map((m) => m.id)).toEqual(["old1"]);
    expect(part.placeOf.get("pin1")).toBe("INBOX");

    // And the Ohbox over the PROJECTED reader — the exact read the product renders — pins it.
    const view = ohboxView(presentationReader(store, part));
    expect(view.resurfaced.map((m) => m.id)).toEqual(["pin1"]);
    expect(view.newForYou).toEqual([]);
    expect(view.previouslySeen).toEqual([]);
  });

  it("an ACTIVE undecided sender's resurfaced row is pinned, not held behind the Screener gate", async () => {
    const pinned = { ...msg({ id: "pin2", from: "active@example.com", folder: "INBOX", date: RECENT, unread: true }), triage: resurfacedState("pin2") };
    const store = await mirrorOf([
      pinned,
      msg({ id: "held1", from: "active@example.com", folder: "ohmail/Screener", date: RECENT, unread: true }),
    ]);
    const part = consentPartition(store, opts);
    expect(part.placeOf.get("pin2")).toBe("INBOX");

    const projected = presentationReader(store, part);
    const view = ohboxView(projected);
    expect(view.resurfaced.map((m) => m.id)).toEqual(["pin2"]);

    // The sender still owes a decision — their queue row stands, holding only the gate mail.
    const seg = screenerSegments(projected, NOW);
    expect(seg.waiting).toHaveLength(1);
    expect(seg.waiting[0]!.held.map((h) => h.id)).toEqual(["held1"]);
  });

  it("REACHABILITY: over every sender standing, a resurfaced row is in exactly one visible surface — the pin", async () => {
    for (const [sender, date, unread] of [
      ["dormant@example.com", OLD, false],
      ["active@example.com", RECENT, true],
      ["quiet-read@example.com", RECENT, false],
    ] as const) {
      const pinned = { ...msg({ id: "pin", from: sender, folder: "INBOX", date, unread }), triage: resurfacedState("pin") };
      const store = await mirrorOf([pinned]);
      const part = consentPartition(store, opts);
      const projected = presentationReader(store, part);

      const view = ohboxView(projected);
      const surfaces = [
        view.resurfaced, view.newForYou, view.previouslySeen,
        [...part.history],
        screenerSegments(projected, NOW).waiting.flatMap((w) => w.held),
      ];
      const appearances = surfaces.flat().filter((m) => m.id === "pin");
      expect(appearances, `${sender} unread=${unread}`).toHaveLength(1);
      expect(view.resurfaced.map((m) => m.id)).toEqual(["pin"]);
    }
  });

  it("reading hands the row back: state `none` re-enters the ordinary rules and leaves the pin", async () => {
    // After the pin is spent (read → state none, server-side), the same row is the cutline's
    // again: a dormant sender's read old mail goes where it always went. The pin never leaks.
    const spent = { ...msg({ id: "sp", from: "dormant@example.com", folder: "INBOX", date: OLD, unread: false }), triage: { messageId: "sp", state: "none", bubbleUpAt: null, setAt: RECENT, updatedAt: RECENT } as unknown as EngineMessage["triage"] };
    const store = await mirrorOf([spent]);
    const part = consentPartition(store, opts);
    expect(part.history.map((m) => m.id)).toEqual(["sp"]);
    expect(ohboxView(presentationReader(store, part)).resurfaced).toEqual([]);
  });
});

/**
 * RULES DO NOT WAIT FOR THE CUTLINE. `rulesOnly` is the partition while the account's
 * window is not known: a paired desktop drew its Ohbox with the partition OFF when its consent
 * read failed, and every unread INBOX message of a ruled sender sat in the Ohbox.
 */
describe("rulesOnly: a ruled sender is placed by its rule before the window is known", () => {
  const world = async () => mirrorOf(
    [
      msg({ id: "kept", from: "friend@example.com", folder: "INBOX", date: RECENT, unread: true }),
      msg({ id: "filed", from: "news@example.com", folder: "INBOX", date: RECENT, unread: true }),
      msg({ id: "filed-old", from: "news@example.com", folder: "INBOX", date: OLD }),
      msg({ id: "stranger", from: "new@example.com", folder: "INBOX", date: RECENT, unread: true }),
      msg({ id: "retired", from: "quiet@example.com", folder: "INBOX", date: OLD }),
      msg({ id: "held", from: "ben@example.com", folder: "ohmail/Screener", date: OLD }),
      msg({ id: "denied", from: "spam@example.com", folder: "INBOX", date: RECENT, unread: true }),
      msg({ id: "sent-old", from: "me@example.com", folder: "Sent", date: OLD }),
    ],
    [
      rule({ id: "r1", kind: "sender", match: "friend@example.com", destination: "INBOX" }),
      rule({ id: "r2", kind: "sender", match: "news@example.com", destination: "ohmail/Reads" as Folder }),
      rule({ id: "r3", kind: "sender", match: "ben@example.com", destination: "INBOX" }),
      rule({ id: "r4", kind: "sender", match: "spam@example.com", destination: "ohmail/Screened" }),
    ],
  );
  const place = (part: ReturnType<typeof consentPartition>, id: string) => part.placeOf.get(id);

  it("files by rule, keeps every unruled row where it is, and cuts nothing to History", async () => {
    const store = await world();
    const part = consentPartition(store, { ...opts, rulesOnly: true, ownAddresses: ["me@example.com"] });
    expect(place(part, "kept")).toBe("INBOX");
    // MOVED with ARCH-R902: the News rule (pre-rename spelling) never moved these,
    // so they stay in the INBOX here exactly as with the window known — the two arms agree from
    // the first render. The DENY rule still puts its mail on the shelf before the window answers.
    expect(place(part, "filed")).toBe("INBOX");
    expect(place(part, "filed-old")).toBe("INBOX");
    expect(place(part, "denied")).toBe("ohmail/Screened");
    // Unknown senders are not queued and not retired while the window is unknown.
    expect(place(part, "stranger")).toBe("INBOX");
    expect(place(part, "retired")).toBe("INBOX");
    // Held mail of a consenting rule waits at the gate, the active reading.
    expect(place(part, "held")).toBe("ohmail/Screener");
    expect(place(part, "sent-old")).toBe("Sent");
    expect(part.history).toEqual([]);
    expect(part.counts).toMatchObject({ activeUndecidedSenders: 0, dormantUndecidedSenders: 0, historyMessages: 0 });
    const ohbox = ohboxView(presentationReader(store, part));
    expect(ohbox.newForYou.map((m) => m.id).sort()).toEqual(["filed", "kept", "stranger"]);
  });

  it("the control: with the window known the same world queues and retires as before", async () => {
    const store = await world();
    const part = consentPartition(store, { ...opts, ownAddresses: ["me@example.com"] });
    expect(place(part, "filed")).toBe("INBOX");
    expect(place(part, "stranger")).toBe("ohmail/Screener");
    expect(place(part, "retired")).toBeNull();
    expect(place(part, "sent-old")).toBeNull();
    expect(part.history.map((m) => m.id).sort()).toEqual(["retired", "sent-old"]);
  });
});

/**
 * A HELD LETTER ITS PROVIDER FAILED PRESENTS AT THE GATE, where the router put it — for the account's
 * own address and for a sender the store says is not waiting (a contact the person wrote to) alike.
 * Only the place moves: every count stays the cutline's own.
 */
describe("a held letter that failed its sender check presents at the gate", () => {
  const verdict = (m: EngineMessage, v: AuthVerdict): EngineMessage => ({ ...m, authVerdict: v });
  /** The store's queue page, answered and whole, listing nobody: every sender at the gate is not waiting. */
  const nobodyWaiting: SyncChange[] = [{
    type: "screener_waiting", op: "create", id: "page", seq: ++seq, updatedAt: NOW.toISOString(),
    entity: { id: "page", kind: "page", total: 0, nextCursor: null, inFlight: [], ask: 1, rows: 0 },
  }] as SyncChange[];
  const mirrorWith = async (messages: EngineMessage[], extra: SyncChange[] = []) => {
    const store = await mirrorOf(messages);
    await store.applyChanges(extra.map((c) => ({ ...c, seq: ++seq })));
    return store;
  };
  const own = { ...opts, ownAddresses: ["me@example.com"] };

  it("the account's own address: a failed letter stays at the gate, an authenticated one presents in the INBOX", async () => {
    const at = () => msg({ id: "letter", from: "me@example.com", folder: "ohmail/Screener", date: RECENT, unread: true });
    const forged = consentPartition(await mirrorWith([verdict(at(), "fail")]), own);
    const genuine = consentPartition(await mirrorWith([verdict(at(), "pass")]), own);
    expect(forged.placeOf.get("letter")).toBe("ohmail/Screener");
    expect(genuine.placeOf.get("letter")).toBe("INBOX");
    expect(forged.counts).toEqual(genuine.counts);
  });

  it("a sender the store does not list: a failed held letter stays at the gate, `unavailable` presents in the INBOX", async () => {
    const at = () => msg({ id: "letter", from: "accountant@smallfirm.example", folder: "ohmail/Screener", date: RECENT, unread: true });
    const forged = consentPartition(await mirrorWith([verdict(at(), "fail")], nobodyWaiting), opts);
    const blind = consentPartition(await mirrorWith([verdict(at(), "unavailable")], nobodyWaiting), opts);
    expect(forged.placeOf.get("letter")).toBe("ohmail/Screener");
    expect(blind.placeOf.get("letter")).toBe("INBOX");
    expect(forged.counts).toEqual(blind.counts);
  });
});
