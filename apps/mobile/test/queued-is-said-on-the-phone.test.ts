/**
 * THE PHONE'S TWIN OF `apps/webapp/test/queued-is-said-in-the-shell.test.tsx` — same invariant,
 * same holder, driven against the same fixture name, on a real wire.
 *
 * `watched()` answered `status !== "rolled_back"`, so every verb that went through it read a
 * request the SERVER had merely RECORDED as a verb that happened: the phone said "Screened out"
 * over a rule nobody had written. Move and Delete were already awaited raw and already said it —
 * everything else was the unmeasured half, and the K32 landing measured that restoring the fold
 * verbatim left three suites and 50 tests green.
 *
 * The verbs driven here are the ones a 202 can actually reach (the adapter's own queued-capable
 * set): the screening ladder's rule writes, and the Screener release's retargets. A triage press
 * cannot be queued — its route answers 403 to a reader — so it is refused, not waiting, and that
 * ending already has its own cases in `message-actions.test.ts`.
 *
 * TO WATCH IT FAIL: in `live.ts`, `watched` → `p.then((r) => (r.status !== "rolled_back" ? {
 * kind: "applied" } : PRESS_THREW), …)` — the shipped fold — and every case here goes red on the
 * sentence while the positive controls stay green.
 */
import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { FOLDER_OF_VIEW } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, type LiveWorldActions } from "../src/state/live";
import { Copy } from "../src/copy";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
import { QUEUED_HOLDER } from "../../../packages/client-engine/test/fixtures/press-answers.js";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

async function liveOn(fake: ReturnType<typeof mailServer>, origin: string) {
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine,
    toast: (m) => toasts.push(sayArg(m)),
    uuid: deps.uuid,
    zone: "UTC",
  });
  return { ...boot, actions, toasts };
}

async function scene(extra: (fake: ReturnType<typeof mailServer>) => void = () => undefined) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "Welcome" }));
  extra(fake);
  const live = await liveOn(fake, origin);
  return { fake, live };
}

/** The sentence the one speaker raises for a press the organizing install is holding. */
const QUEUED_SAID = Copy.pressQueuedForOrganizer(QUEUED_HOLDER);

describe("the phone says queued for every verb that can be queued", () => {
  /**
   * SCREENING A SENDER writes a rule. On an account whose live mailboxes another install
   * organizes, `POST /rules` answers without writing a rule, and no rule row exists here — "Screened out" over that
   * is a claim about a rule nobody made.
   */
  it("a rule the server only recorded is told as a wait, not as a decision", async () => {
    const { fake, live } = await scene();
    fake.queueNextForOrganizer("PATCH", "/rules/r-allow", QUEUED_HOLDER);

    await live.actions.screenSender("m1", "reads", "sender");

    expect(live.toasts).toContain(QUEUED_SAID);
    expect(
      live.toasts.filter((t) => t === sayArg({ key: "liveDecided", args: [Copy.placeReads, "sender@fake.test"] } as never)),
      "the phone claimed a decision over a rule nobody wrote",
    ).toHaveLength(0);
    live.store.close();
    fake.server.close();
  });

  /** An unnamed holder is a real holder — the sentence drops the name, never the fact. */
  it("an unnamed organizer still gets the wait's own sentence", async () => {
    const { fake, live } = await scene();
    fake.queueNextForOrganizer("PATCH", "/rules/r-allow", null);
    await live.actions.screenSender("m1", "reads", "sender");
    expect(live.toasts).toContain(Copy.pressQueuedForOrganizerUnknown);
    live.store.close();
    fake.server.close();
  });

  /**
   * THE POSITIVE CONTROL: an ordinary screening still says it decided, and never the wait. The
   * `applied` arm has to stay reachable or the case above is measuring a function that always
   * answers the same thing.
   */
  it("an applied screening still says it decided", async () => {
    const { fake, live } = await scene();
    expect(await live.actions.screenSender("m1", "reads", "sender")).toBe(true);
    expect(live.toasts.some((t) => t.startsWith("Queued for")), "an applied press reported as waiting").toBe(false);
    expect(live.toasts.length, "the ordinary press said nothing").toBeGreaterThan(0);
    live.store.close();
    fake.server.close();
  });

  /**
   * THE RELEASE, whose retargets are `rule_update`s — the phone's twin of the webapp Screener
   * row. Nothing refused and something waiting leaves the sender where they are and says so.
   */
  it("a release whose retarget is recorded says the wait and moves nobody", async () => {
    const { fake, live } = await scene((f) => {
      f.addRule(ruleDto("r-spam", "sender", "held@fake.test", FOLDER_OF_VIEW.spam));
      f.addMessage({
        ...dto("m2", { subject: "Held" }),
        from: { name: "Held sender", address: "held@fake.test" },
        folder: FOLDER_OF_VIEW.spam,
      });
    });
    fake.queueNextForOrganizer("PATCH", "/rules/r-spam", QUEUED_HOLDER);

    const row = { id: "m2", address: "held@fake.test", held: [{ id: "m2" }] } as Parameters<LiveWorldActions["release"]>[0];
    await live.actions.release(row, "ohbox", "spam");

    /* TWO SENTENCES, AND THE SECOND ONE CORRECTS THE FIRST: the release raises its optimistic
       line at the press (the verb is this machine's and the only question was whether the wire
       took it), and the answer then says what actually happened. What may never stand alone is
       the optimistic one — which is exactly what it did before this change. */
    expect(live.toasts).toContain(QUEUED_SAID);
    expect(live.toasts.at(-1), "the wait was not the last word").toBe(QUEUED_SAID);
    expect(
      live.engine.read().get<EngineMessage>("message", "m2"),
      "the released message left the mirror over a retarget nobody made",
    ).toBeDefined();
    live.store.close();
    fake.server.close();
  });
});
