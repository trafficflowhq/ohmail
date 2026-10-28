/**
 * THE PHONE'S TWIN: a press about one sender never changes how another sender's mail is filed.
 * Allow / Not spam (`release`) and Move (the routing window's ladder, `planPhoneRouting`) each
 * driven with the sender held by a DOMAIN rule and by their own rule, against the loopback mail
 * server, read on the wire, in the mirror afterwards and in the sentence each deck renders.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type RuleDTO } from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { DE } from "../src/copy.de";
import { sayArg } from "../src/refusal";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { closeRoutingSession, openRoutingSession } from "../src/state/held-routing";
import { destDone } from "../src/state/model";
import {
  dispatchHeldRouting,
  liveActions,
  liveMessage,
  liveScreener,
  moveTargetLabel,
  phonePressRules,
  planHeldRouting,
  planPhoneRouting,
  presentedOf,
  type ToastOpts,
  type WorldView,
} from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const DOMAIN = "lists.example.test";
const PRESSED = { name: "News", address: `news@${DOMAIN}` };
const OTHER = { name: "Offers", address: `offers@${DOMAIN}` };
const QUARANTINE = "ohmail/Quarantine";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };

type Fake = ReturnType<typeof mailServer>;

/** `copy`: the organizer's published rules; `rulesTravel`: a change made here travels to it; `holder`: the live organizer this device reads under. */
async function scene(
  rules: RuleDTO[], extra: ReturnType<typeof dto>[] = [],
  opts: { copy?: RuleDTO[]; rulesTravel?: boolean; letterFolder?: string; holder?: string } = {},
) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  for (const r of rules) fake.addRule(r);
  if (opts.copy) {
    const at = "2026-08-19T09:00:00Z";
    fake.push("mailbox_profile", "create", "mb-1", {
      mailboxId: "mb-1", rules: opts.copy, asOf: at, from: { kind: "local", name: "Laptop", since: null }, updatedAt: at, applied: [],
    });
  }
  fake.addMessage(dto("q1", { subject: "Pressed", folder: opts.letterFolder ?? QUARANTINE, from: PRESSED }));
  fake.addMessage(dto("o1", { subject: "Other", folder: QUARANTINE, from: OTHER, date: "2026-08-19T07:00:00Z" }));
  for (const m of extra) fake.addMessage(m);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  let lastOpts: ToastOpts | undefined;
  let lastUndo: (() => void) | undefined;
  const actions = liveActions({
    engine: boot.engine, uuid: deps.uuid, zone: "UTC", ...(opts.rulesTravel ? { rulesTravel: () => true } : {}),
    ...(opts.holder ? { readsOnly: () => ({ organizedBy: { kind: "local", name: opts.holder! }, organizerState: "held" as const }) } : {}),
    toast: (m, o) => { toasts.push(sayArg(m)); lastOpts = o; if (o?.undo) lastUndo = o.undo; },
  });
  return { fake, ...boot, actions, toasts, lastOpts: () => lastOpts, lastUndo: () => lastUndo };
}

const ruleWire = (fake: Fake) => fake.seen.filter((r) => r.url.startsWith("/rules") && r.method !== "GET");
/** The letters' moves on the wire, each with whether it went as the rule's (`pressRule`): such a letter decides no place of its own. */
const moveWire = (fake: Fake) => fake.seen.filter((r) => r.method === "POST" && r.url.endsWith("/move"))
  .map((r) => `${r.url} ${JSON.parse(r.body).folder}${JSON.parse(r.body).pressRule === true ? " pressRule" : ""}`);
const spamAddresses = (s: Awaited<ReturnType<typeof scene>>) =>
  liveScreener(presentedOf(s.engine.read(), view.now), view).spam.map((r) => r.address).sort();
const spamRow = (s: Awaited<ReturnType<typeof scene>>) => {
  const row = liveScreener(presentedOf(s.engine.read(), view.now), view).spam.find((r) => r.address === PRESSED.address);
  expect(row, "the sender is not in Spam").toBeTruthy();
  return row!;
};
const priority = (r: RuleDTO, p: number): RuleDTO => ({ ...r, priority: p });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

afterEach(() => { closeRoutingSession(); resetLocaleRegisterForTests(); });

describe("Not spam on the phone", () => {
  it("held by a DOMAIN rule: an address rule for them alone, the domain rule untouched", async () => {
    const s = await scene([ruleDto("r-dom", "domain", DOMAIN, QUARANTINE)]);
    try {
      expect(await s.actions.release(spamRow(s), "ohbox", "spam")).toBe(true);
      const wire = ruleWire(s.fake);
      expect(wire.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /rules"]);
      expect(JSON.parse(wire[0]!.body)).toMatchObject({ kind: "sender", match: PRESSED.address, destination: "INBOX" });
      expect(s.fake.rule("r-dom")?.destination, "the domain rule was rewritten").toBe(QUARANTINE);
      expect(moveWire(s.fake)).toEqual(["/messages/q1/move INBOX pressRule"]);
      await s.engine.syncOnce();
      expect(spamAddresses(s), "another sender at the domain left Spam").toEqual([OTHER.address]);
      expect(s.toasts).toContain(Copy.liveReleasedAddress(1, destDone("ohbox"), DOMAIN));
    } finally { s.store.close(); s.fake.server.close(); }
  });

  it("held by their OWN rule: that rule is retargeted and nothing is created", async () => {
    const s = await scene([ruleDto("r-own", "sender", PRESSED.address, QUARANTINE), ruleDto("r-other", "sender", OTHER.address, QUARANTINE)]);
    try {
      expect(await s.actions.release(spamRow(s), "ohbox", "spam")).toBe(true);
      expect(ruleWire(s.fake).map((r) => `${r.method} ${r.url}`)).toEqual(["PATCH /rules/r-own"]);
      expect(moveWire(s.fake)).toEqual(["/messages/q1/move INBOX pressRule"]);
      expect(s.toasts).toContain(Copy.liveReleasedRuled(1, destDone("ohbox")));
    } finally { s.store.close(); s.fake.server.close(); }
  });

  it("a domain rule the address rule cannot outrank is said, and nothing is sent", async () => {
    const s = await scene([priority(ruleDto("r-dom", "domain", DOMAIN, QUARANTINE), 5)]);
    try {
      expect(await s.actions.release(spamRow(s), "ohbox", "spam")).toBe(false);
      expect(s.fake.seen.filter((r) => r.method !== "GET").map((r) => r.url)).toEqual([]);
      expect(s.toasts).toContain(Copy.liveReleaseRuleStands(PRESSED.address, DOMAIN));
    } finally { s.store.close(); s.fake.server.close(); }
  });

  it("the German deck says it too", async () => {
    setActiveLocale("de");
    const s = await scene([ruleDto("r-dom", "domain", DOMAIN, QUARANTINE)]);
    try {
      await s.actions.release(spamRow(s), "ohbox", "spam");
      expect(s.toasts).toContain(DE.liveReleasedAddress(1, destDone("ohbox"), DOMAIN));
    } finally { s.store.close(); s.fake.server.close(); }
  });
});

describe("Move on the phone, out of a domain rule's pile", () => {
  const row = (s: Awaited<ReturnType<typeof scene>>) => {
    const m = liveMessage(s.engine, "q1", view);
    expect(m?.presentedFolder, "the message is not shown in Spam").toBe(QUARANTINE);
    return m!;
  };

  it("with no window to hold it, an address rule goes at once and the domain rule is untouched", async () => {
    const s = await scene([ruleDto("r-dom", "domain", DOMAIN, QUARANTINE)]);
    try {
      expect(await s.actions.move(row(s), "ohbox")).toBe(true);
      const wire = ruleWire(s.fake);
      expect(wire.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /rules"]);
      expect(JSON.parse(wire[0]!.body)).toMatchObject({ kind: "sender", match: PRESSED.address, destination: "INBOX" });
      expect(s.fake.rule("r-dom")?.destination).toBe(QUARANTINE);
    } finally { s.store.close(); s.fake.server.close(); }
  });

  it("held by their OWN rule: the retarget is unchanged", async () => {
    const s = await scene([ruleDto("r-own", "sender", PRESSED.address, QUARANTINE)]);
    try {
      expect(await s.actions.move(row(s), "ohbox")).toBe(true);
      expect(ruleWire(s.fake).map((r) => `${r.method} ${r.url}`)).toEqual(["PATCH /rules/r-own"]);
    } finally { s.store.close(); s.fake.server.close(); }
  });

  it("the routing window commits the address rule, re-planned, exactly once", async () => {
    const s = await scene([ruleDto("r-dom", "domain", DOMAIN, QUARANTINE)]);
    try {
      // The window's own dispatch is the event: the case reads the wire once it has landed.
      let landed!: () => void;
      const dispatched = new Promise<void>((r) => { landed = r; });
      openRoutingSession({
        windowMs: 30,
        journal: s.store,
        plan: (i) => planHeldRouting(s.engine.read(), i),
        dispatch: async (ms) => { await Promise.all(ms.map((m) => s.engine.mutate(m))); landed(); },
      });
      expect(await s.actions.move(row(s), "ohbox")).toBe(true);
      expect(ruleWire(s.fake), "a rule went out inside the undo window").toEqual([]);
      await dispatched;
      expect(ruleWire(s.fake).map((r) => `${r.method} ${r.url}`)).toEqual(["POST /rules"]);
      await s.engine.syncOnce();
      // The ladder asked again finds the address rule standing and writes nothing more.
      const again = planPhoneRouting(s.engine.read(), {
        v: 1, id: "p2", seedId: "q1", address: PRESSED.address, scope: "sender",
        dest: "ohbox", messageIds: ["q1"], from: QUARANTINE, at: 0,
      });
      expect(again).toEqual([]);
    } finally { s.store.close(); s.fake.server.close(); }
  });

  it("Undo inside the window sends no rule at all", async () => {
    const s = await scene([ruleDto("r-dom", "domain", DOMAIN, QUARANTINE)]);
    try {
      openRoutingSession({
        windowMs: 30,
        journal: s.store,
        plan: (i) => planHeldRouting(s.engine.read(), i),
        dispatch: async (ms) => { await Promise.all(ms.map((m) => s.engine.mutate(m))); },
      });
      expect(await s.actions.move(row(s), "ohbox")).toBe(true);
      const undo = s.lastOpts()?.undo;
      expect(undo, "the Move offered no Undo").toBeTruthy();
      undo!();
      await tick(120);
      expect(ruleWire(s.fake), "Undo let a rule out").toEqual([]);
      expect(s.fake.rule("r-dom")?.destination).toBe(QUARANTINE);
    } finally { s.store.close(); s.fake.server.close(); }
  });
});

/* the phone half: Allow and Not spam wrote their rule at the press and
   offered no Undo, where Move holds its rule for the routing window. They hold it now, the same way. */
describe("Not spam inside the routing window", () => {
  const windowed = (s: Awaited<ReturnType<typeof scene>>, ms: number): Promise<void> => {
    let landed!: () => void;
    const dispatched = new Promise<void>((r) => { landed = r; });
    openRoutingSession({
      windowMs: ms,
      journal: s.store,
      plan: (i) => planHeldRouting(s.engine.read(), i),
      dispatch: async (m) => { await Promise.all(m.map((x) => s.engine.mutate(x))); landed(); },
    });
    return dispatched;
  };

  it("holds the rule, offers Undo, and Undo sends no rule and moves the letter back", async () => {
    const s = await scene([ruleDto("r-dom", "domain", DOMAIN, QUARANTINE)]);
    try {
      void windowed(s, 60);
      expect(await s.actions.release(spamRow(s), "ohbox", "spam")).toBe(true);
      expect(ruleWire(s.fake), "a rule went out inside the undo window").toEqual([]);
      const undo = s.lastOpts()?.undo;
      expect(undo, "the release offered no Undo").toBeTruthy();
      undo!();
      await tick(200);
      expect(ruleWire(s.fake), "Undo let a rule out").toEqual([]);
      expect(moveWire(s.fake), "the letter's move and its way back, both the release's own").toEqual([
        "/messages/q1/move INBOX pressRule", `/messages/q1/move ${QUARANTINE} pressRule`,
      ]);
    } finally { s.store.close(); s.fake.server.close(); }
  });

  /* PHONE-RULE-BRANCH-UNDO-SAYS-NOTHING-TO-UNDO, the release's arm: a later press about the sender
     replaced the rule half only, so Undo still takes the released letter back, and says so. */
  it("replaced by a later press about the sender, Undo takes the letter back and says the later choice stands", async () => {
    const s = await scene([ruleDto("r-dom", "domain", DOMAIN, QUARANTINE)], [dto("q2", { subject: "Later", from: PRESSED })]);
    try {
      void windowed(s, 400);
      expect(await s.actions.release(spamRow(s), "ohbox", "spam")).toBe(true);
      const undo = s.lastOpts()?.undo;
      expect(undo, "the release offered no Undo").toBeTruthy();
      const q2 = liveMessage(s.engine, "q2", view);
      expect(await s.actions.move(q2!, "receipts")).toBe(true);
      undo!();
      expect(s.toasts.at(-1)).toBe(Copy.undoReplacedLetterBack);
      await tick(200);
      expect(s.engine.read().get<{ folder: string }>("message", "q1")?.folder, "the released letter stayed out").toBe(QUARANTINE);
    } finally { s.store.close(); s.fake.server.close(); }
  });

  /* LOW-5: a letter the organizer was asked to move has no way back from
     here — the engine drops the optimistic move — so the replaced press's Undo sends nothing for it. */
  it("replaced, with its letter queued for the organizer, Undo moves nothing and says so", async () => {
    const s = await scene([ruleDto("r-dom", "domain", DOMAIN, QUARANTINE)], [dto("q2", { subject: "Later", from: PRESSED })]);
    try {
      s.fake.queueNextForOrganizer("POST", "/messages/q1/move", "Desk");
      void windowed(s, 400);
      await s.actions.release(spamRow(s), "ohbox", "spam");
      /* The pill that offered Undo; the answer's sentence (the wait) is raised after it. */
      const undo = s.lastUndo();
      expect(undo, "the release offered no Undo").toBeTruthy();
      expect(s.engine.read().get<{ folder: string }>("message", "q1")?.folder, "the premise: the queued move is not drawn").toBe(QUARANTINE);
      expect(await s.actions.move(liveMessage(s.engine, "q2", view)!, "receipts")).toBe(true);
      const before = s.fake.seen.length;
      undo!();
      expect(s.toasts.at(-1)).toBe(Copy.undoReplaced);
      await tick(200);
      const moves = s.fake.seen.slice(before).filter((r) => r.method === "POST" && r.url === "/messages/q1/move");
      expect(moves, "the queued letter was moved back from here").toEqual([]);
    } finally { s.store.close(); s.fake.server.close(); }
  });

  it("left alone, the window commits the address rule once, with the release's backlog pass", async () => {
    const s = await scene([ruleDto("r-dom", "domain", DOMAIN, QUARANTINE)]);
    try {
      const dispatched = windowed(s, 30);
      expect(await s.actions.release(spamRow(s), "ohbox", "spam")).toBe(true);
      await dispatched;
      const wire = ruleWire(s.fake);
      expect(wire.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /rules"]);
      expect(wire[0]!.body).not.toContain('"applyRetro":false');
    } finally { s.store.close(); s.fake.server.close(); }
  });
});


/* A READER-ONLY PHONE: this device's row says Screened, the organizer's copy files them to Spam. */
describe("Not spam and Move where a rule change travels to the organizer", () => {
  const stale = () => scene([ruleDto("r-own", "sender", PRESSED.address, "ohmail/Screened")], [],
    { copy: [ruleDto("profile:mb-1:0", "sender", PRESSED.address, QUARANTINE)], rulesTravel: true });
  const patches = (fake: Fake) => ruleWire(fake).map((r) => `${r.method} ${r.url} ${JSON.parse(r.body || "{}").destination ?? ""}`);

  it("Not spam rewrites the rule the organizer files them by", async () => {
    const s = await stale();
    try {
      expect(await s.actions.release(spamRow(s), "ohbox", "spam")).toBe(true);
      expect(patches(s.fake)).toEqual(["PATCH /rules/r-own INBOX"]);
    } finally { s.store.close(); s.fake.server.close(); }
  });

  it("Move out of Spam rewrites it too", async () => {
    const s = await stale();
    try {
      const m = liveMessage(s.engine, "q1", view);
      expect(m?.presentedFolder).toBe(QUARANTINE);
      expect(await s.actions.move(m!, "ohbox")).toBe(true);
      expect(patches(s.fake)).toEqual(["PATCH /rules/r-own INBOX"]);
    } finally { s.store.close(); s.fake.server.close(); }
  });

  /* The letter already in the Inbox, shown in Spam only by the copy: the press is the rule alone, and
     that is a request the organizer has not made yet. */
  const ruleOnly = () => scene([], [], {
    copy: [ruleDto("profile:mb-1:0", "sender", PRESSED.address, QUARANTINE)], rulesTravel: true, letterFolder: "INBOX", holder: "Laptop",
  });
  const readerWindow = (s: Awaited<ReturnType<typeof scene>>): Promise<void> => {
    let landed!: () => void;
    const dispatched = new Promise<void>((r) => { landed = r; });
    openRoutingSession({
      windowMs: 30,
      journal: s.store,
      plan: (i) => planHeldRouting(s.engine.read(), i, undefined, phonePressRules(s.engine, true, new Date())),
      dispatch: async (m, i) => {
        const out = await dispatchHeldRouting(s.engine, m, i, { answered: () => false, refused: () => {} });
        landed();
        return out;
      },
    });
    return dispatched;
  };

  it("Not spam over the rule alone says it waits for the organizer", async () => {
    const s = await ruleOnly();
    try {
      s.fake.queueNextForOrganizer("PATCH", "/rules/", "Laptop");
      const dispatched = readerWindow(s);
      await s.actions.release(spamRow(s), "ohbox", "spam");
      expect(moveWire(s.fake), "a letter already in the Inbox was moved").toEqual([]);
      expect(s.toasts).toEqual([Copy.pressQueuedForOrganizer("Laptop")]);
      await dispatched;
      expect(patches(s.fake)).toEqual([`PATCH /rules/00000000-0000-0000-0000-000000000000 INBOX`]);
    } finally { s.store.close(); s.fake.server.close(); }
  });

  it("Move over the rule alone says it waits for the organizer", async () => {
    const s = await ruleOnly();
    try {
      s.fake.queueNextForOrganizer("PATCH", "/rules/", "Laptop");
      const dispatched = readerWindow(s);
      const m = liveMessage(s.engine, "q1", view);
      expect(m?.presentedFolder, "the premise: the copy shows the letter in Spam").toBe(QUARANTINE);
      expect(await s.actions.move(m!, "ohbox")).toBe(true);
      expect(moveWire(s.fake)).toEqual([]);
      expect(s.toasts).toEqual([Copy.toastMoveQueuedWithRule(moveTargetLabel("ohbox"), "Laptop")]);
      await dispatched;
      expect(patches(s.fake)).toEqual([`PATCH /rules/00000000-0000-0000-0000-000000000000 INBOX`]);
    } finally { s.store.close(); s.fake.server.close(); }
  });
});
