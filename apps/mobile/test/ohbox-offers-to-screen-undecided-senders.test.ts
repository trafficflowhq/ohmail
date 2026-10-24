/**
 * MAIL ALREADY IN THE INBOX WHEN THE PHONE CONNECTS STAYS IN THE OHBOX, AND THE PHONE OFFERS TO
 * SCREEN ITS SENDERS, AS THE WEB DOES. The rig corpus's shape: the account wrote to Mara before
 * the connect, and her letter and a stranger's wait in the Inbox with nobody's decision behind
 * them. The offer is the store's `GET /screener/unscreened`; the press is the web's `POST`, and
 * it holds both senders at the gate. The real engine and wire, the phone's own derivations.
 */
import { afterEach, describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  liveActions, liveOhbox, liveScreener, liveUnscreened, presentedOf, type WorldView,
} from "../src/state/live";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { readFoldersEnabled, readSeedReview } from "../src/net/consent";
import {
  advanceSeedOffer, bindSeedOfferKV, relaunchSeedOfferForTests, seedAnswered, seedLater, seedNotNowKey, seedOfferOf,
  seedStage, unscreenedOffered, worldSeedOf, type SeedFacts, type SeedMailbox,
} from "../src/state/seed-offer";
import type { SecureKV } from "../src/state/servers";
import { initialTicks, pressConfirm } from "../src/ui/seed-review";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };

const OWNER = { name: "Owner", address: "owner@fake.test" };
const MARA = { name: "Mara Lindqvist", address: "mara@rig-corpus.test" };
const STRANGER = { name: "Nobody Known", address: "nobody@stranger.test" };

async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage({
    ...dto("sent-mara", { subject: "Keys", folder: "Sent", from: OWNER, unread: false, date: "2026-08-19T07:00:00Z" }),
    to: [MARA],
  });
  fake.addMessage(dto("plain", { subject: "Plain note", from: MARA, date: "2026-08-19T07:10:00Z" }));
  fake.addMessage(dto("first", { subject: "First contact", from: STRANGER, date: "2026-08-19T07:15:00Z" }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: string[] = [];
  const actions = liveActions({ engine: boot.engine, uuid: deps.uuid, zone: "UTC", toast: (m) => { said.push(sayArg(m)); } });
  /* The world's cadence after a drain: the queue from the store, and the offer beside it. */
  const cadence = async () => {
    await boot.engine.syncOnce();
    await boot.engine.refreshScreenerWaiting();
    await boot.engine.refreshUnscreened();
  };
  const pres = () => presentedOf(boot.engine.read(), view.now);
  const ohboxIds = () => {
    const box = liveOhbox(pres(), view);
    return [...box.resurfaced, ...box.fresh, ...box.seen].map((m) => m.id);
  };
  const waiting = () => liveScreener(pres(), view).waiting.map((r) => r.address).sort();
  const close = () => { boot.store.close(); fake.server.close(); };
  return { fake, engine: boot.engine, actions, said, cadence, ohboxIds, waiting, close };
}

afterEach(() => { resetLocaleRegisterForTests(); });

describe("the Ohbox offers to screen senders already in the Inbox", () => {
  it("names both senders, and its press holds them in the Screener", async () => {
    const s = await scene();
    try {
      await s.cadence();
      expect(s.ohboxIds(), "the mail in the Inbox at the connect left the Ohbox").toEqual(expect.arrayContaining(["first", "plain"]));
      expect(s.waiting(), "a sender nobody decided about is already held").toEqual([]);
      expect(liveUnscreened(s.engine.read()), "the phone offers nothing over the store's answer").toEqual({
        total: 2, senders: [MARA.address, STRANGER.address],
      });

      expect(await s.actions.screenUnscreened()).toBe(true);
      expect(s.fake.seen.filter((r) => r.method === "POST").map((r) => r.url)).toEqual(["/screener/unscreened"]);
      expect(s.said).toEqual(["Screened 2. Your organizer moves them on the next pass."]);
      expect(liveUnscreened(s.engine.read()), "the offer outlived its press").toBeNull();

      await s.cadence();
      expect(s.waiting(), "the press held nobody").toEqual([MARA.address, STRANGER.address].sort());
      expect(s.ohboxIds(), "held mail stayed in the Ohbox").not.toEqual(expect.arrayContaining(["first"]));
      expect(s.ohboxIds(), "held mail stayed in the Ohbox").not.toEqual(expect.arrayContaining(["plain"]));
    } finally { s.close(); }
  });

  it("says a refused press in the web's words and keeps the offer", async () => {
    setActiveLocale("de");
    const s = await scene();
    try {
      await s.cadence();
      s.fake.failNext("POST", "/screener/unscreened");
      expect(await s.actions.screenUnscreened()).toBe(false);
      expect(s.said).toEqual(["Screenen nicht möglich. Versuch es noch einmal."]);
      expect(liveUnscreened(s.engine.read())?.total).toBe(2);
      expect(s.ohboxIds()).toEqual(expect.arrayContaining(["first", "plain"]));
    } finally { s.close(); }
  });
});

/* ── THE SENT-MAIL SEED COMES FIRST ─────────────────────────────────────────────────────────────
 * Mara is somebody the account wrote to: while the seed is owed, "Screen N" would hold her, so it
 * waits; the offer names her, its confirm writes her rule and the Ohbox offer then names only the
 * stranger. "Not now" is kept per account on this device; the cases with nothing to ask ask nothing. */
const ORGANIZER_ROW = { status: "active", organizerRole: "organizer" as const, initialImportCompletedAt: "2026-08-19T06:00:00Z" };
const REVIEW = {
  candidates: [{ address: MARA.address, name: MARA.name, messages: 1, lastWrittenAt: "2026-08-19T07:00:00Z", alreadyDecided: false }],
  excluded: [], scannedMessages: 1, truncated: false,
};
function memoryKV(): SecureKV & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v), remove: async (k) => void map.delete(k) };
}
async function seedScene(o: { confirmedAt?: string | null | undefined; review?: unknown } = {}) {
  const s = await scene();
  s.fake.setSeedConfirmedAt("confirmedAt" in o ? o.confirmedAt : null);
  s.fake.setSeedReview(o.review ?? REVIEW);
  const origin = `http://127.0.0.1:${(s.fake.server.address() as { port: number }).port}`;
  const session = { profile: { origin, apiBase: null }, fetch: (url: string, init?: unknown) => globalThis.fetch(url, init as RequestInit) };
  const facts = async (rows: SeedMailbox[] = [ORGANIZER_ROW], profileQuestionOpen = false): Promise<SeedFacts> => ({
    seed: worldSeedOf((await readFoldersEnabled(session as never))!.seed), mailboxes: { known: true, rows }, profileQuestionOpen,
  });
  const reviewReads = () => s.fake.seen.filter((r) => r.method === "GET" && r.url === "/consent/seed").length;
  const posts = () => s.fake.seen.filter((r) => r.method === "POST" && r.url === "/consent/seed");
  return { ...s, session, facts, reviewReads, posts, read: () => readSeedReview(session) };
}

describe("the sent-mail seed on the phone", () => {
  afterEach(() => { relaunchSeedOfferForTests(); });

  it("is asked before 'Screen N', and its confirm lets the person written to through", async () => {
    const s = await seedScene();
    const kv = memoryKV();
    bindSeedOfferKV(kv);
    try {
      await s.cadence();
      const facts = await s.facts();
      expect(seedStage(facts)).toBe("owed");
      await advanceSeedOffer("owner-a", facts, s.read);
      const offer = seedOfferOf("owner-a", facts);
      expect(offer.kind === "offer" && offer.undecided, "the phone never asked the seed").toBe(1);
      expect(unscreenedOffered(offer, liveUnscreened(s.engine.read())), "'Screen N' would hold Mara first").toBeNull();
      if (offer.kind !== "offer") return;

      expect(await pressConfirm(s.session, offer.review, initialTicks(offer.review), "press-1")).toBeNull();
      seedAnswered("owner-a");
      expect(s.posts().map((p) => [p.body, p.key])).toEqual([[JSON.stringify({ addresses: [MARA.address] }), "press-1"]]);
      await s.cadence();
      /* A stale read still saying "never confirmed" does not bring the offer back, and "Screen N" returns. */
      const stale = { ...facts, seed: { known: true as const, carried: true as const, confirmedAt: null } };
      const after = seedOfferOf("owner-a", stale);
      expect(after.kind).toBe("settled");
      expect(unscreenedOffered(after, liveUnscreened(s.engine.read()))).toEqual({ total: 1, senders: [STRANGER.address] });
      expect(s.ohboxIds()).toEqual(expect.arrayContaining(["first", "plain"]));
      expect(s.reviewReads(), "the review was read more than once").toBe(1);
    } finally { s.close(); }
  });

  it("'Not now' posts nothing and is kept for this account: a new launch does not ask, another account does", async () => {
    const s = await seedScene();
    const kv = memoryKV();
    bindSeedOfferKV(kv);
    try {
      const facts = await s.facts();
      await advanceSeedOffer("owner-a", facts, s.read);
      expect(seedOfferOf("owner-a", facts).kind).toBe("offer");
      await seedLater("owner-a");
      expect(seedOfferOf("owner-a", facts).kind).toBe("settled");
      expect(s.posts()).toEqual([]);

      relaunchSeedOfferForTests();
      bindSeedOfferKV(kv);
      await advanceSeedOffer("owner-a", facts, s.read);
      expect(seedOfferOf("owner-a", facts).kind).toBe("settled");
      expect(s.reviewReads(), "a kept 'Not now' still read the review").toBe(1);
      await advanceSeedOffer("http://other::acct-2", facts, s.read);
      expect(seedOfferOf("http://other::acct-2", facts).kind, "account A's answer applied to account B").toBe("offer");
      expect(kv.map.has(seedNotNowKey("http://other::acct-2"))).toBe(false);
    } finally { s.close(); }
  });

  it("asks nothing where nothing is owed or the facts are not in", async () => {
    const s = await seedScene();
    try {
      const reader = { ...ORGANIZER_ROW, organizerRole: "reader" as const };
      const importing = { ...ORGANIZER_ROW, initialImportCompletedAt: null };
      for (const [facts, offer] of [
        [await s.facts([reader]), "settled"],
        [await s.facts([importing]), "waiting"],
        [await s.facts([ORGANIZER_ROW], true), "waiting"],
      ] as const) {
        await advanceSeedOffer("owner-a", facts, s.read);
        expect(seedOfferOf("owner-a", facts).kind).toBe(offer);
      }
      expect(s.reviewReads()).toBe(0);
      s.fake.setSeedConfirmedAt(undefined);
      const older = await s.facts();
      await advanceSeedOffer("owner-a", older, s.read);
      expect(seedOfferOf("owner-a", older).kind, "a door with no seed was asked").toBe("settled");
      expect(s.reviewReads()).toBe(0);
    } finally { s.close(); }
  });

  it("nobody undecided, or a review that cannot be read, settles it for this launch", async () => {
    const decided = { ...REVIEW, candidates: [{ ...REVIEW.candidates[0], alreadyDecided: true }] };
    const s = await seedScene({ review: decided });
    try {
      const facts = await s.facts();
      await advanceSeedOffer("owner-a", facts, s.read);
      expect(seedOfferOf("owner-a", facts).kind).toBe("settled");
      s.fake.failNext("GET", "/consent/seed");
      await advanceSeedOffer("owner-b", facts, s.read);
      expect(seedOfferOf("owner-b", facts).kind).toBe("settled");
      expect(s.posts()).toEqual([]);
    } finally { s.close(); }
  });

  it("a refused confirm keeps the ticks, and the retry is a new key with the same list", async () => {
    const s = await seedScene();
    try {
      const review = (await s.read())!;
      const ticks = initialTicks(review);
      s.fake.failNext("POST", "/consent/seed");
      const refused = await pressConfirm(s.session, review, ticks, "press-1");
      expect(refused).toEqual({ state: "ready", review, error: "refused by test" });
      expect([...ticks]).toEqual([MARA.address]);
      expect(await pressConfirm(s.session, review, ticks, "press-2")).toBeNull();
      expect(s.posts().map((p) => [p.body, p.key])).toEqual([
        [JSON.stringify({ addresses: [MARA.address] }), "press-1"],
        [JSON.stringify({ addresses: [MARA.address] }), "press-2"],
      ]);
    } finally { s.close(); }
  });
});
