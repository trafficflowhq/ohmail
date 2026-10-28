/**
 * EVERY SCREENER DECISION ON THE PHONE OFFERS UNDO (PHONE-SCREENER-DECISIONS-HAVE-NO-UNDO). The
 * web Screener holds each decision for `UNDO_MS` before anything is sent; the phone sent a decide
 * at the press with a text-only sentence, and past the gate wrote the rule at once, so its Undo
 * moved a letter back under a rule that stood. Each decision is now held on the phone's one routing
 * window: nothing leaves inside it, Undo sends nothing, and the close sends the decision re-read
 * from the mirror. Driven on the real engine over the loopback wire, read on the wire.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { EngineMessage } from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  answerScreenPress, closeRoutingSession, flushRouting, noteScreenChanged, openRoutingSession, routingPlaces, routingReader,
} from "../src/state/held-routing";
import {
  liveActions, liveMessage, liveScreener, planHeldRouting, presentedOf, UNDO_MS,
  type LiveDeps, type ToastOpts, type WorldView,
} from "../src/state/live";
import type { Destination, Scope } from "../src/state/model";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };
const STRANGER = { name: "New Sender", address: "new@stranger.test" };
const WINDOW_MS = 60;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => { closeRoutingSession(); });

/** One launch with the routing session the app opens (`world.tsx`), over one letter at `folder`. */
async function scene(folder: string, extra: Partial<LiveDeps> = {}) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("s1", { subject: "Hello there", folder, from: STRANGER }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: Array<{ text: string; opts?: ToastOpts }> = [];
  const actions = liveActions({
    engine: boot.engine, uuid: deps.uuid, zone: "UTC",
    toast: (m, o) => { said.push({ text: sayArg(m), ...(o ? { opts: o } : {}) }); },
    ...extra,
  });
  openRoutingSession({
    windowMs: WINDOW_MS, journal: boot.store,
    plan: (i) => planHeldRouting(boot.engine.read(), i, (changed) => noteScreenChanged(i.id, changed)),
    dispatch: async (ms, i) => {
      const answers = await Promise.all(ms.map((m) => boot.engine.mutate(m).catch(() => null)));
      answerScreenPress(i.id, ms, answers);
    },
  });
  const wire = () => fake.seen.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.url}`);
  const shelf = () => liveScreener(routingReader(presentedOf(boot.engine.read(), view.now), routingPlaces()), view).waiting;
  const close = () => { boot.store.close(); fake.server.close(); };
  return { fake, ...boot, actions, said, wire, shelf, close };
}

type Scene = Awaited<ReturnType<typeof scene>>;
const press = (s: Scene, dest: Destination, read: boolean, scope: Scope) =>
  s.actions.decide(s.shelf()[0]!, dest, read, scope);

/** Each class: where the letter is, the press, and what the window's close puts on the wire. */
const CLASSES: Array<{ name: string; folder: string; dest: Destination; read: boolean; scope: Scope; sent: string[] }> = [
  { name: "let in, at the gate", folder: "ohmail/Screener", dest: "ohbox", read: false, scope: "sender", sent: ["POST /screener/s1"] },
  { name: "let in and read, at the gate", folder: "ohmail/Screener", dest: "ohbox", read: true, scope: "sender", sent: ["POST /screener/s1", "PATCH /messages"] },
  { name: "screen out, at the gate", folder: "ohmail/Screener", dest: "screened", read: false, scope: "sender", sent: ["POST /screener/s1"] },
  { name: "screen out and read, at the gate", folder: "ohmail/Screener", dest: "screened", read: true, scope: "sender", sent: ["POST /screener/s1", "PATCH /messages"] },
  { name: "spam, at the gate", folder: "ohmail/Screener", dest: "spam", read: false, scope: "sender", sent: ["POST /screener/s1"] },
  { name: "spam and read, at the gate", folder: "ohmail/Screener", dest: "spam", read: true, scope: "sender", sent: ["POST /screener/s1", "PATCH /messages"] },
  { name: "a domain press, at the gate", folder: "ohmail/Screener", dest: "ohbox", read: false, scope: "domain", sent: ["POST /screener/s1"] },
  { name: "let in, past the gate", folder: "INBOX", dest: "ohbox", read: false, scope: "sender", sent: ["POST /rules"] },
  { name: "screen out, past the gate", folder: "INBOX", dest: "screened", read: false, scope: "sender", sent: ["POST /rules", "POST /messages/s1/move"] },
  { name: "a domain press, past the gate", folder: "INBOX", dest: "screened", read: false, scope: "domain", sent: ["POST /rules", "POST /messages/s1/move"] },
];

describe("a Screener decision on the phone is held with Undo", () => {
  for (const c of CLASSES) {
    it(`${c.name}: the sentence offers Undo for UNDO_MS, nothing leaves, and Undo sends nothing`, async () => {
      const s = await scene(c.folder);
      try {
        expect(s.shelf(), "the sender is not waiting").toHaveLength(1);
        expect(await press(s, c.dest, c.read, c.scope)).toBe(true);
        const last = s.said.at(-1);
        expect(last?.opts?.undo, `the sentence is text only: ${last?.text}`).toBeTypeOf("function");
        expect(last?.opts?.holdMs).toBe(UNDO_MS);
        expect(s.wire(), "the decision left inside its undo window").toEqual([]);
        expect(s.shelf(), "the decided sender stayed on the shelf").toHaveLength(0);

        last!.opts!.undo!();
        await tick(WINDOW_MS * 5);
        expect(s.wire(), "Undo left the decision on the wire").toEqual([]);
        expect(s.said.at(-1)?.text).toBe(Copy.toastUndone);
        expect(s.engine.read().get<EngineMessage>("message", "s1")?.folder).toBe(c.folder);
        expect(s.shelf(), "the undone sender did not come back").toHaveLength(1);
      } finally { s.close(); }
    }, 30_000);

    it(`${c.name}: the window's close sends the decision, re-read from the mirror`, async () => {
      const s = await scene(c.folder);
      try {
        await press(s, c.dest, c.read, c.scope);
        await tick(WINDOW_MS * 5);
        expect(s.wire()).toEqual(c.sent);
        const body = JSON.parse(s.fake.seen.find((r) => r.method === "POST")!.body) as Record<string, unknown>;
        if (c.folder === "INBOX") {
          // Ruled: past the gate the rule asks no past-mail answer; the card's own letter moves by id.
          expect(body).toMatchObject({ kind: c.scope, applyRetro: false });
        } else {
          expect(body).toMatchObject({ scope: c.scope });
        }
        expect(s.said).toHaveLength(1);
      } finally { s.close(); }
    }, 30_000);
  }

  it("a move-only press (Move, no rule) offers Undo too, and takes the letter back", async () => {
    const s = await scene("ohmail/Screener");
    try {
      expect(await s.actions.move(liveMessage(s.engine, "s1", view)!, "ohbox")).toBe(true);
      const last = s.said.at(-1);
      expect(last?.opts?.undo).toBeTypeOf("function");
      expect(last?.opts?.holdMs).toBe(UNDO_MS);
      last!.opts!.undo!();
      await tick(WINDOW_MS * 5);
      expect(s.engine.read().get<EngineMessage>("message", "s1")?.folder).toBe("ohmail/Screener");
    } finally { s.close(); }
  }, 30_000);

  it("an Undo pressed after the window has sent the decision says so and takes nothing back", async () => {
    const s = await scene("ohmail/Screener");
    try {
      await press(s, "screened", false, "sender");
      const undo = s.said.at(-1)!.opts!.undo!;
      flushRouting();
      await tick(WINDOW_MS * 5);
      undo();
      await tick(WINDOW_MS * 5);
      expect(s.said.at(-1)?.text).toBe(Copy.liveDecideUndoLate);
      expect(s.wire()).toEqual(["POST /screener/s1"]);
    } finally { s.close(); }
  }, 30_000);

  it("the paired shelf holds the row off for the window, and forgets it once the decide lands", async () => {
    const events: string[] = [];
    const s = await scene("ohmail/Screener", {
      leaveWaiting: (d) => { events.push(`leave ${d.scope}`); return () => events.push("release"); },
      forgetWaiting: (d) => { events.push(`forget ${d.scope}`); },
    });
    try {
      await press(s, "ohbox", false, "sender");
      expect(events).toEqual(["leave sender"]);
      await tick(WINDOW_MS * 5);
      expect(events).toEqual(["leave sender", "forget sender", "release"]);
    } finally { s.close(); }
  }, 30_000);

  it("with no session open the decision goes at once, as before — the fallback", async () => {
    const s = await scene("ohmail/Screener");
    try {
      closeRoutingSession();
      expect(await press(s, "screened", false, "sender")).toBe(true);
      expect(s.wire()).toEqual(["POST /screener/s1"]);
      expect(s.said.at(-1)?.opts?.undo).toBeUndefined();
    } finally { s.close(); }
  }, 30_000);

  it("with no session open, the ✓ beside Screen out files and marks the shown letter read", async () => {
    const s = await scene("ohmail/Screener");
    try {
      closeRoutingSession();
      expect(await press(s, "screened", true, "sender")).toBe(true);
      await tick(WINDOW_MS * 5);
      expect(s.wire()).toEqual(["POST /screener/s1", "PATCH /messages"]);
      const patch = JSON.parse(s.fake.seen.find((r) => r.method === "PATCH")!.body) as Record<string, unknown>;
      expect(patch).toMatchObject({ ids: ["s1"], unread: false });
    } finally { s.close(); }
  }, 30_000);
});
