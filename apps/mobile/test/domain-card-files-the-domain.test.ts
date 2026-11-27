/**
 * The phone's whole-domain card (ruled): before the press it names every other waiting sender at the
 * domain and how many of their letters move, and its press moves exactly that set — the decide with
 * no past-mail answer, and each INBOX letter by id, whether the press is sent at once or held for
 * the undo window. An answer the gate admitted at that domain is never in the set. The sheet is
 * measured by its code with comments blanked (no RN renderer here).
 */
import { afterEach, describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { sayArg } from "../src/refusal";
import { Copy } from "../src/copy";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { closeRoutingSession, noteScreenChanged, openRoutingSession } from "../src/state/held-routing";
import {
  dispatchHeldRouting, domainScopeOffered, liveActions, liveScreener, planHeldRouting, presentedOf, type WorldView,
} from "../src/state/live";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = (rel: string) => withoutComments(fs.readFileSync(path.join(HERE, "..", rel), "utf8"));
const view: WorldView = { now: new Date("2026-08-19T10:00:00Z"), zone: "UTC" };
const A = "a@letters.test";
const B = "b@letters.test";
const C = "c@letters.test";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

afterEach(() => { closeRoutingSession(); });

/** A held letter from A, B's letter in the INBOX, and an answer the gate admitted from C. */
async function scene(a = A, b = B) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("ga", { from: { name: "A", address: a }, folder: "ohmail/Screener" }));
  fake.addMessage(dto("bi", { from: { name: "B", address: b }, folder: "INBOX" }));
  const answer = { ...dto("ci", { from: { name: "C", address: C }, folder: "INBOX" }), placeDecided: true as const };
  fake.addMessage(answer);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: string[] = [];
  const actions = liveActions({ engine: boot.engine, toast: (m) => { said.push(String(sayArg(m))); }, uuid: deps.uuid, zone: "UTC" });
  const waiting = liveScreener(presentedOf(boot.engine.read(), view.now), view, { [a]: "domain" }).waiting;
  const moves = () => fake.seen.filter((r) => r.method === "POST" && /^\/messages\/[^/]+\/move$/.test(r.url)).map((r) => r.url);
  const decides = () => fake.seen.filter((r) => r.method === "POST" && r.url.startsWith("/screener/"));
  const close = () => { boot.store.close(); fake.server.close(); };
  return { ...boot, fake, actions, said, waiting, moves, decides, close };
}

async function until(ok: () => boolean, ms = 1500): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

describe("the phone's whole-domain card", () => {
  it("names the other sender before the press, and its press moves that sender's INBOX letter and not the admitted answer", async () => {
    const s = await scene();
    try {
      expect(s.waiting.map((w) => w.address).sort()).toEqual([A, B]);
      const a = s.waiting.find((w) => w.address === A)!;
      expect(s.actions.reachOf(a, s.waiting, "domain").others).toEqual([{ address: B, count: 1 }]);
      expect(await s.actions.decide(a, "reads", false, "domain", s.waiting)).toBe(true);
      await until(() => s.moves().length >= 1);
      expect(s.moves()).toEqual(["/messages/bi/move"]);
      expect((JSON.parse(s.decides()[0]!.body) as { applyRetro?: boolean; scope?: string })).toMatchObject({ applyRetro: false, scope: "domain" });
    } finally { s.close(); }
  });

  it("held for the undo window, the commit moves the same set", async () => {
    const s = await scene();
    try {
      let landed!: () => void;
      const done = new Promise<void>((r) => { landed = r; });
      openRoutingSession({
        windowMs: 30,
        journal: s.store,
        plan: (i) => planHeldRouting(s.engine.read(), i, (changed) => noteScreenChanged(i.id, changed)),
        dispatch: async (ms) => { await Promise.all(ms.map((m) => s.engine.mutate(m).catch(() => null))); landed(); },
      });
      const a = s.waiting.find((w) => w.address === A)!;
      expect(await s.actions.decide(a, "reads", false, "domain", s.waiting)).toBe(true);
      expect(s.moves(), "a letter moved inside the undo window").toEqual([]);
      await done;
      expect(s.moves()).toEqual(["/messages/bi/move"]);
    } finally { s.close(); }
  });

  it("a sender decided inside the domain decision's window keeps its own decision for its letter", async () => {
    const s = await scene();
    try {
      let left = 2;
      let landed!: () => void;
      const done = new Promise<void>((r) => { landed = r; });
      openRoutingSession({
        windowMs: 30,
        journal: s.store,
        plan: (i) => planHeldRouting(s.engine.read(), i, (changed) => noteScreenChanged(i.id, changed)),
        dispatch: async (ms) => {
          await Promise.all(ms.map((m) => s.engine.mutate(m).catch(() => null)));
          if (--left === 0) landed();
        },
      });
      const a = s.waiting.find((w) => w.address === A)!;
      const b = s.waiting.find((w) => w.address === B)!;
      expect(await s.actions.decide(a, "reads", false, "domain", s.waiting)).toBe(true);
      expect(await s.actions.decide({ ...b, scope: "sender" }, "receipts", false, "sender", s.waiting)).toBe(true);
      await done;
      const bodies = s.fake.seen.filter((r) => r.method === "POST" && r.url === "/messages/bi/move").map((r) => JSON.parse(r.body) as { folder?: string });
      expect(bodies.map((x) => x.folder)).toEqual(["ohmail/Receipts"]);
    } finally { s.close(); }
  });

  it("a refused decision moves no letter by id, and says it was not saved", async () => {
    const s = await scene();
    try {
      const a = s.waiting.find((w) => w.address === A)!;
      s.fake.failNextStatus("POST", "/screener/", 422);
      expect(await s.actions.decide(a, "reads", false, "domain", s.waiting)).toBe(false);
      await new Promise((r) => setTimeout(r, 300));
      expect(s.decides()).toHaveLength(1);
      expect(s.moves()).toEqual([]);
      expect(s.said.join(" | ")).toContain("could not be saved");
    } finally { s.close(); }
  });

  it("held for the undo window, a refused decision moves no letter by id either", async () => {
    const s = await scene();
    try {
      let landed!: () => void;
      const done = new Promise<void>((r) => { landed = r; });
      openRoutingSession({
        windowMs: 30,
        journal: s.store,
        plan: (i) => planHeldRouting(s.engine.read(), i, (changed) => noteScreenChanged(i.id, changed)),
        dispatch: async (ms, intent) => {
          const r = await dispatchHeldRouting(s.engine, ms, intent, { answered: () => false, refused: () => { s.said.push("SAVE_FAILED"); } });
          landed();
          return r;
        },
      });
      const a = s.waiting.find((w) => w.address === A)!;
      s.fake.failNextStatus("POST", "/screener/", 422);
      await s.actions.decide(a, "reads", false, "domain", s.waiting);
      await done;
      await new Promise((r) => setTimeout(r, 200));
      expect(s.moves()).toEqual([]);
    } finally { s.close(); }
  });

  it("CONTROL: a sender scope press names nobody else and leaves the other sender's letter", async () => {
    const s = await scene();
    try {
      const a = s.waiting.find((w) => w.address === A)!;
      expect(s.actions.reachOf(a, s.waiting, "sender").others).toEqual([]);
      expect(await s.actions.decide(a, "reads", false, "sender", s.waiting)).toBe(true);
      await until(() => s.decides().length >= 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(s.moves()).toEqual([]);
    } finally { s.close(); }
  });
});

describe("the sheet says it and hands the press the same rows", () => {
  const sheet = source("src/ui/SenderDetail.tsx");

  it("draws the line from the waiting rows and passes them to the press", () => {
    expect(sheet).toMatch(/w\.actions\.reachOf\(row, w\.screener\.waiting\)/);
    expect(sheet).toMatch(/Copy\.domainAlsoFiles\(/);
    expect(sheet).toMatch(/\{also !== null \? \(\s*<Txt[^>]*testID="decide-domain-also">\s*\{also\}/);
    expect(sheet).toMatch(/w\.actions\.decide\(row, dest, read, w\.screener\.waiting, unsubscribeIds\)/);
  });

  it("the world forwards both to the live actions", () => {
    const w = source("src/state/world.tsx");
    expect(w).toMatch(/decide: \(row, dest, read, peers, ids\) => void acts\.decide\(row, dest, read, row\.scope, peers, ids\)/);
    expect(w).toMatch(/reachOf: \(row, peers\) => acts\.reachOf\(row, peers, row\.scope\)/);
  });

  it("the line counts and names", () => {
    expect(Copy.domainAlsoFiles(3, `${B} (2), x@letters.test (1)`)).toContain(`${B} (2)`);
    expect(Copy.domainAlsoFiles(3, "")).toContain("3");
  });
});

describe("no whole-domain scope for a shared provider, as on the web", () => {
  const SHARED_A = personalAt("fixture.nadja", "gmx.net");
  const SHARED_B = personalAt("fixture.jonas", "gmx.net");

  it("is not offered, and a row there keeps the sender scope whatever was set", async () => {
    expect([domainScopeOffered(SHARED_A), domainScopeOffered(A)]).toEqual([false, true]);
    const s = await scene(SHARED_A, SHARED_B);
    try {
      expect(s.waiting.find((w) => w.address === SHARED_A)?.scope).toBe("sender");
    } finally { s.close(); }
  });

  it("a press asked at domain scope there is sent at the sender's", async () => {
    const s = await scene(SHARED_A, SHARED_B);
    try {
      const a = s.waiting.find((w) => w.address === SHARED_A)!;
      expect(await s.actions.decide(a, "reads", false, "domain", s.waiting)).toBe(true);
      await until(() => s.decides().length >= 1);
      expect((JSON.parse(s.decides()[0]!.body) as { scope?: string }).scope).toBe("sender");
      await new Promise((r) => setTimeout(r, 200));
      expect(s.moves()).toEqual([]);
    } finally { s.close(); }
  });

  it("the sheet draws no scope switch where it is not offered", () => {
    const sheet = source("src/ui/SenderDetail.tsx");
    expect(sheet).toContain("const domainOffered = domainScopeOffered(row.address);");
    expect(sheet).toMatch(/domainOffered \? \(\s*<View ref=\{scopeMenu.anchorRef\}/);
    expect(sheet).toContain('open={menu === "scope" && domainOffered}');
    expect(sheet).toContain("domainOffered={domainOffered}");
    expect(sheet).toMatch(/const scopeControl = !domainOffered \? null : \(/);
  });
});
