/**
 * THE NO-COLLAPSE RULE, as an executable promise over the live selectors.
 *
 * "All mail always rendered; no 'N collapsed / N more' placeholders." A comment cannot
 * enforce that. This census can: it seeds a synthetic corpus into a REAL loopback server,
 * boots the same engine composition the app runs, and enumerates every mail identity the
 * screens' selectors put on screen — at every depth: list rows, receipts day groups,
 * screener held bags, thread conversations, pile items. The screens render by iterating
 * exactly these selectors, so a list that quietly summarised itself would drop identities
 * here and fail below.
 *
 * The suite bites in both directions:
 *   · nothing from the seeded corpus may be missing (no collapse), and
 *   · nothing outside the corpus may appear (no invention).
 *
 * The corpus is TEST-SIDE synthetic data (this file and its helper never ship): the app
 * itself carries no sample mail — privacy.test.ts holds that half of the ruling.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EngineMessage, type OhmailEngine } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  liveActions,
  liveHistory,
  liveMessage,
  liveOhbox,
  livePiles,
  liveReads,
  liveReceipts,
  liveScreener,
  presentedOf,
  presentedWorld,
  type WorldView,
} from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };

/** The corpus, by surface. Every id here must render somewhere; nothing else may. */
const SEED = {
  // A decided sender (allow rule → INBOX), incl. a two-message conversation.
  ohbox: ["o-new", "o-thread-a", "o-thread-b"],
  // Triaged into Answer Later below — presented on the PILE surface, not the ohbox list.
  piled: ["o-seen"],
  // A two-message conversation parked whole: one pile row carrying both ids.
  parked: ["p-thread-a", "p-thread-b"],
  reads: ["rd-1", "rd-2"],
  // Three receipts across two days, so the day-grouping is exercised.
  receipts: ["rc-1", "rc-2", "rc-3"],
  // Two strangers waiting at the gate, one with a two-message held bag.
  waitingHeld: ["w-lena-1", "w-lena-2", "w-paper-1"],
  screenedHeld: ["sc-1", "sc-2"],
  spamHeld: ["sp-1"],
};
const ALL_IDS = Object.values(SEED).flat();

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

const fake = mailServer();
let origin = "";
let engine: OhmailEngine;
let closeStore: () => void = () => undefined;

beforeAll(async () => {
  origin = await listen(fake.server);
  const at = (d: string) => `2026-08-${d}${"T"}08:00:00Z`;
  const sender = (tag: string) => ({ name: tag, address: `${tag}@corpus.test` });

  fake.addRule(ruleDto("r-allow-a", "sender", "alice@corpus.test", "INBOX"));
  fake.addMessage(dto("o-new", { subject: "o-new", from: sender("alice"), date: at("18") }));
  fake.addMessage(dto("o-seen", { subject: "o-seen", from: sender("alice"), unread: false, date: at("17") }));
  const thread = (id: string, date: string) => {
    const m = dto(id, { subject: id, from: sender("alice"), unread: false, date });
    m.threadId = "th-1";
    fake.addMessage(m);
  };
  thread("o-thread-a", at("16"));
  thread("o-thread-b", at("15"));
  for (const [id, d] of [["p-thread-a", "14"], ["p-thread-b", "13"]] as const) {
    const m = dto(id, { subject: id, from: sender("alice"), unread: false, date: at(d) });
    m.threadId = "th-2";
    fake.addMessage(m);
  }

  fake.addMessage(dto("rd-1", { subject: "rd-1", folder: "ohmail/News", from: sender("issuer"), date: at("18") }));
  fake.addMessage(dto("rd-2", { subject: "rd-2", folder: "ohmail/News", from: sender("issuer"), unread: false, date: at("14") }));

  fake.addMessage(dto("rc-1", { subject: "rc-1", folder: "ohmail/Receipts", from: sender("shop"), date: at("18") }));
  fake.addMessage(dto("rc-2", { subject: "rc-2", folder: "ohmail/Receipts", from: sender("shop"), date: at("18") }));
  fake.addMessage(dto("rc-3", { subject: "rc-3", folder: "ohmail/Receipts", from: sender("shop"), unread: false, date: at("12") }));

  fake.addMessage(dto("w-lena-1", { subject: "w-lena-1", folder: "ohmail/Screener", from: sender("lena"), date: at("17") }));
  fake.addMessage(dto("w-lena-2", { subject: "w-lena-2", folder: "ohmail/Screener", from: sender("lena"), date: at("18") }));
  fake.addMessage(dto("w-paper-1", { subject: "w-paper-1", folder: "ohmail/Screener", from: sender("paperbird"), date: at("18") }));

  fake.addRule(ruleDto("r-hold-noise", "sender", "noise@corpus.test", "ohmail/Screened"));
  fake.addMessage(dto("sc-1", { subject: "sc-1", folder: "ohmail/Screened", from: sender("noise"), date: at("16") }));
  fake.addMessage(dto("sc-2", { subject: "sc-2", folder: "ohmail/Screened", from: sender("noise"), date: at("17") }));

  fake.addMessage(dto("sp-1", { subject: "sp-1", folder: "ohmail/Quarantine", from: sender("jackpot"), date: at("18") }));

  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  engine = boot.engine;
  closeStore = () => boot.store.close();
  await boot.verifyIdentity(); // the app's own sequence: the verdict opens the drain routes
  await engine.start();

  // One pile item, through the same mutation the message screen dispatches — so the piles
  // surface renders a real triage item whose identity the census can demand back.
  const actions = liveActions({ engine, toast: () => undefined });
  await actions.setPile("o-seen", "replyLater");
  for (const id of SEED.parked) await actions.setPile(id, "setAside");
  await engine.syncOnce();
});

afterAll(() => {
  closeStore();
  fake.server.close();
});

/** Every identity the screens render, at every depth — the full manifest. */
function fullManifest(): string[] {
  /* HISTORY IS A SURFACE NOW, so the manifest has to reach it or the census goes blind to a
     whole list. It is EMPTY under this file's inputs — no cutline answer means `all_time`, which
     retires nobody — and that is the point: every seeded id must still be reachable somewhere
     else, and a future partition change that started retiring this corpus would show up here as
     mail the other lists lost rather than as nothing at all. */
  const parted = presentedWorld(engine.read(), view.now);
  const historyIds = liveHistory(engine.read(), parted.history, view).items.map((m) => m.id);
  const pres = presentedOf(engine.read(), view.now);
  const box = liveOhbox(pres, view);
  const reads = liveReads(pres, view);
  const receipts = liveReceipts(pres, view);
  const screener = liveScreener(pres, view);
  const piles = livePiles(pres, view);

  const listIds = [
    ...[...box.resurfaced, ...box.fresh, ...box.seen].map((m) => m.id),
    ...reads.items.map((m) => m.id),
    ...receipts.groups.flatMap((g) => g.items.map((m) => m.id)),
  ];
  // The reading view renders the whole conversation under every list row.
  const threadIds = listIds.flatMap((id) => (liveMessage(engine, id, view)?.earlier ?? []).map((h) => h.id));
  const heldIds = [...screener.waiting, ...screener.screened, ...screener.spam].flatMap((r) =>
    r.held.map((h) => h.id),
  );
  const pileIds = piles.flatMap((p) => p.items.flatMap((i) => i.memberIds ?? [i.messageId ?? i.id]));
  return [...listIds, ...threadIds, ...heldIds, ...pileIds, ...historyIds];
}

describe("every seeded identity is reachable on some screen", () => {
  it("the full manifest covers the whole corpus — nothing collapsed", () => {
    const rendered = new Set(fullManifest());
    const missing = ALL_IDS.filter((id) => !rendered.has(id));
    expect(missing).toEqual([]);
  });

  it("invents nothing: every rendered identity is seeded corpus mail", () => {
    const corpus = new Set(ALL_IDS);
    const invented = fullManifest().filter((id) => !corpus.has(id));
    expect(invented).toEqual([]);
  });
});

describe("per-surface manifests are complete", () => {
  /* One row per CONVERSATION (2026-09-28): the two-message thread is one row, and the
     union of the rows' members is the whole corpus — folded, never dropped. `total` counts messages. */
  it("the Ohbox renders all three, split but never truncated (the piled one moved surface)", () => {
    const pres = presentedOf(engine.read(), view.now);
    const box = liveOhbox(pres, view);
    const rows = [...box.resurfaced, ...box.fresh, ...box.seen];
    const members = rows.flatMap((m) => m.memberIds ?? [m.id]).sort();
    expect(members).toEqual([...SEED.ohbox].sort());
    expect(rows.length, "the thread folded into one row").toBe(SEED.ohbox.length - 1);
    expect(box.total).toBe(SEED.ohbox.length);
  });

  it("Reads renders both issues", () => {
    const pres = presentedOf(engine.read(), view.now);
    expect(liveReads(pres, view).items.map((m) => m.id).sort()).toEqual([...SEED.reads].sort());
  });

  it("Receipts spans two day groups and loses none across them", () => {
    const pres = presentedOf(engine.read(), view.now);
    const r = liveReceipts(pres, view);
    expect(r.groups.length).toBeGreaterThanOrEqual(2);
    expect(r.groups.flatMap((g) => g.items.map((m) => m.id)).sort()).toEqual([...SEED.receipts].sort());
    expect(r.total).toBe(SEED.receipts.length);
  });

  it("every screener shelf shows its senders with the WHOLE held bag — no 'and 3 more'", () => {
    const pres = presentedOf(engine.read(), view.now);
    const s = liveScreener(pres, view);
    const bag = (rows: typeof s.waiting) => rows.flatMap((r) => r.held.map((h) => h.id)).sort();
    expect(bag(s.waiting)).toEqual([...SEED.waitingHeld].sort());
    expect(bag(s.screened)).toEqual([...SEED.screenedHeld].sort());
    expect(bag(s.spam)).toEqual([...SEED.spamHeld].sort());
    // Lena's two held messages ride ONE row, both rendered — the collapsed-count shape.
    const lena = s.waiting.find((r) => r.address === "lena@corpus.test");
    expect(lena?.held.map((h) => h.id).sort()).toEqual(["w-lena-1", "w-lena-2"]);
  });

  it("the conversation renders in full under the message — the badge is backed by rendered mail", () => {
    const m = liveMessage(engine, "o-thread-a", view);
    expect(m?.earlier.map((h) => h.id)).toEqual(["o-thread-b"]);
    const other = liveMessage(engine, "o-thread-b", view);
    expect(other?.earlier.map((h) => h.id)).toEqual(["o-thread-a"]);
  });

  it("the pile item keeps the message's identity — a count is never invented", () => {
    const pres = presentedOf(engine.read(), view.now);
    const piles = livePiles(pres, view);
    const reply = piles.find((p) => p.kind === "replyLater");
    expect(reply?.items.map((i) => i.messageId)).toEqual(["o-seen"]);
    const parked = piles.find((p) => p.kind === "setAside");
    expect(parked?.items.map((i) => i.memberIds), "the parked conversation is one row with both").toEqual([["p-thread-a", "p-thread-b"]]);
    expect(piles.reduce((n, p) => n + p.items.length, 0)).toBe(2);
  });
});

describe("the census itself bites", () => {
  it("a dropped identity is detected — the manifest is not a tautology", () => {
    // Simulate the collapse the rule bans: a manifest missing one seeded id must differ.
    const rendered = new Set(fullManifest());
    rendered.delete("w-lena-1");
    const missing = ALL_IDS.filter((id) => !rendered.has(id));
    expect(missing).toEqual(["w-lena-1"]);
  });

  it("engine rows carry the seeded folders — the corpus landed where the census assumes", () => {
    const reader = engine.read();
    expect(reader.get<EngineMessage>("message", "rd-1")?.folder).toBe("ohmail/News");
    expect(reader.get<EngineMessage>("message", "sp-1")?.folder).toBe("ohmail/Quarantine");
    expect(reader.list("message")).toHaveLength(ALL_IDS.length);
  });
});
