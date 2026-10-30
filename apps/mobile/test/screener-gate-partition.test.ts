/**
 * THE PAIRED PHONE'S SCREENER IS THE SERVER'S QUEUE — measured on a device, then fixed here.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *
 * On the rig (AVD `ohmail-r8`, the paired shot account, a release build off main) `GET /screener`
 * answered NINE waiting senders — one message each, every one of them physically in
 * `ohmail/Screener` — and the phone's Screener settled at FOUR. Not the cutline (all nine are
 * post-cutoff under the account's own answer), not a short mirror (all nine open on the phone
 * with real bodies), not the grouping key.
 *
 * `consentPartition` re-homes a DECIDED sender's gate mail to the rule's destination — "a ruled
 * sender presents in the rule's destination (zero server moves)", which is the right answer for
 * the Ohbox. `screenerSegments` then groups by folder over that projection, so those senders were
 * no longer at the gate and left the queue. The five missing each carried an ENABLED sender rule
 * pointing at INBOX, Reads or Receipts, written weeks BEFORE their mail arrived — the rule exists,
 * the mail is still held, and the server still asks. The server's own queue consults no rules at
 * all (`screener-service.ts#list` over `heldSenderPage`), so the two ends were answering two
 * different questions and the phone showed the narrower one as the mailbox's own count.
 *
 * The webapp derives its queue from the SAME call over the same projection
 * (`apps/webapp/app/shell/screener-state.ts`), so the browser answers 4 on this input too.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────────────────────
 *
 * On a PAIRED door the Screener shows the server's set — the senders `GET /screener` returns —
 * and a message the server holds in `ohmail/Screener` is titled Screener on the reading screen.
 * The client partition is the STANDALONE door's answer, and on a paired door it is the offline
 * fallback, labelled as one.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FOLDER_OF_VIEW, type OhmailEngine } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  liveMessage, liveScreener, presentedOf, screeningAnswered, SCREENING_UNSUPPLIED, type WorldView,
} from "../src/state/live";
import { screenerMetaOf } from "../src/state/world-projection";
import { readScreenerWaiting, type ServerWaitingSender } from "../src/net/screener";
import type { ConnectedSession } from "../src/net/pairing";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const view: WorldView = { now: NOW, zone: "UTC" };
/** The shot account's own answer, as `GET /consent` gave it: every sender below is post-cutoff. */
const ACCOUNT = { dormancyDays: 60, baselineAt: "2026-08-12T01:21:58.372Z", scope: "window" } as const;
/** The posture every caller here is in: the consent read landed, and this is what it said. */
const ANSWERED = screeningAnswered(ACCOUNT);
const RECENT = "2026-09-01T08:00:00.000Z";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })(),
};

/** The queue read asks through the engine's own door, so the session carries the booted engine. */
function sessionFor(origin: string, engine: OhmailEngine): ConnectedSession {
  return {
    profile: { origin },
    engine,
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  } as unknown as ConnectedSession;
}

async function bootOn(origin: string) {
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  return boot;
}

/** One stranger's message, held at the gate. */
function held(fake: ReturnType<typeof mailServer>, n: number, date = RECENT): void {
  fake.addMessage(dto(`s${n}`, {
    subject: `From stranger ${n}`,
    folder: FOLDER_OF_VIEW.screener,
    from: { name: `Stranger ${n}`, address: `stranger${n}@fake.test` },
    date,
    unread: false,
  }));
}

/**
 * THE MEASURED SHAPE, as a fixture: five held senders, three of them carrying an enabled rule
 * that lets them through — the three destinations the rig's five actually carried.
 */
function fiveHeldThreeRuled(fake: ReturnType<typeof mailServer>): void {
  for (const n of [1, 2, 3, 4, 5]) held(fake, n);
  fake.addRule(ruleDto("r-2", "sender", "stranger2@fake.test", "INBOX"));
  fake.addRule(ruleDto("r-3", "sender", "stranger3@fake.test", "ohmail/News"));
  fake.addRule(ruleDto("r-4", "sender", "stranger4@fake.test", "ohmail/Receipts"));
}

describe("a ruled sender's mail is still held, and the queue still asks", () => {
  it("THE PARTITION: a device answer is labelled the device's, and the route's set wins", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fiveHeldThreeRuled(fake);
      const boot = await bootOn(origin);
      const pres = presentedOf(boot.engine.read(), NOW, false, ANSWERED);

      // The server is holding five senders at the gate and says so.
      const server = await readScreenerWaiting(sessionFor(origin, boot.engine));
      expect(server!.map((s) => s.address).sort()).toEqual(
        [1, 2, 3, 4, 5].map((n) => `stranger${n}@fake.test`),
      );
      /* Without the route, the door answers from its own partition and the answer is LABELLED
         as its own — that label is the property, not a count. This read two of five when the
         case was written: the device partition re-homed a ruled sender's gate-held mail and
         dropped them off the shelf. The engine's cutline keeps gate-held mail at the gate now,
         so the two answers agree here; a count pinned to the defect would have had to be
         rewritten by whoever fixed it and would say nothing about the fallback itself. What
         holds either way is that the device can only answer from what its mirror holds. */
      const device = liveScreener(pres, view, {}, null);
      expect(device.source).toBe("device");
      expect(device.waiting.every((r) => server!.some((s) => s.address === r.address))).toBe(true);

      // With the route's answer in hand the shelf is the route's set, in the route's order.
      const paired = liveScreener(pres, view, {}, server);
      expect(paired.source).toBe("server");
      expect(paired.waiting.map((r) => r.address)).toEqual(server!.map((s) => s.address));
      expect(paired.waiting).toHaveLength(5);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a ruled sender's row carries the mirror's own held mail, not the route's one line", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fiveHeldThreeRuled(fake);
      // A second message from the ruled sender, also at the gate: the row must hold both.
      fake.addMessage(dto("s2b", {
        subject: "From stranger 2 again",
        folder: FOLDER_OF_VIEW.screener,
        from: { name: "Stranger 2", address: "stranger2@fake.test" },
        date: "2026-09-02T08:00:00.000Z",
        unread: false,
      }));
      const boot = await bootOn(origin);
      const server = await readScreenerWaiting(sessionFor(origin, boot.engine));
      const rows = liveScreener(presentedOf(boot.engine.read(), NOW, false, ANSWERED), view, {}, server).waiting;
      const ruled = rows.find((r) => r.address === "stranger2@fake.test");
      expect(ruled!.held.map((h) => h.id)).toEqual(["s2", "s2b"]);
      // The gate can resolve a decide on it — it is physically held, whatever the rule says.
      expect(ruled!.gatePhysical).toBe(true);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("the reading screen titles a gate-held message Screener, never the Ohbox it is not in", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fiveHeldThreeRuled(fake);
      const boot = await bootOn(origin);
      /* The ruled sender's message: the projection PRESENTS it in the Ohbox (its rule's
         destination), so `place` says "ohbox" — about mail the reader is being asked to decide
         on. `gateHeld` is the correction, and it is read off the PHYSICAL folder. */
      const ruled = liveMessage(boot.engine, "s2", { ...view, screening: ANSWERED })!;
      expect(ruled.place).toBe("ohbox");
      expect(ruled.folder).toBe(FOLDER_OF_VIEW.screener);
      expect(ruled.gateHeld).toBe(true);
      // …and an unruled held sender's message is titled Screener for the same reason, where the
      // place name would ALSO have said Ohbox: `Place` has no Screener value at all.
      const plain = liveMessage(boot.engine, "s1", { ...view, screening: ANSWERED })!;
      expect(plain.place).toBe("ohbox");
      expect(plain.gateHeld).toBe(true);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("an Ohbox message is not titled Screener — the flag is the physical folder, not a default", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("inbox-1", {
        subject: "Ordinary",
        folder: "INBOX",
        from: { name: "Known", address: "known@fake.test" },
        date: RECENT,
        unread: false,
      }));
      fake.addRule(ruleDto("r-k", "sender", "known@fake.test", "INBOX"));
      const boot = await bootOn(origin);
      const m = liveMessage(boot.engine, "inbox-1", { ...view, screening: ANSWERED })!;
      expect(m.place).toBe("ohbox");
      expect(m.gateHeld).toBeUndefined();
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("the reading screen reads the flag, between History and the folder leaf", () => {
    // The reading view is `MessageReader` now — the route and the two-pane surfaces mount it.
    const screen = src("src/ui/MessageReader.tsx");
    expect(screen).toContain("m.gateHeld ? Copy.screener :");
  });
});

describe("the paired shelf is the route's set — no more and no less", () => {
  it("a sender the route does not name leaves the shelf, whatever the mirror holds", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      for (const n of [1, 2]) held(fake, n);
      const boot = await bootOn(origin);
      const pres = presentedOf(boot.engine.read(), NOW, false, ANSWERED);
      /* The route answers with ONE of the two — the shape a decision taken on another door
         leaves behind (`listOutstandingForAccount` excludes it while the organizer carries it
         out) while this phone's mirror still has the mail at the gate. */
      const server = (await readScreenerWaiting(sessionFor(origin, boot.engine)))!
        .filter((s) => s.address === "stranger1@fake.test");
      const rows = liveScreener(pres, view, {}, server).waiting;
      expect(rows.map((r) => r.address)).toEqual(["stranger1@fake.test"]);
      // …and the device's own list still holds both, which is what makes the filter load-bearing.
      expect(liveScreener(pres, view, {}, null).waiting).toHaveLength(2);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a sender the route names and this windowed mirror cannot back still gets a row", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      held(fake, 1);
      const boot = await bootOn(origin);
      const pres = presentedOf(boot.engine.read(), NOW, false, ANSWERED);
      const server: ServerWaitingSender[] = [
        ...(await readScreenerWaiting(sessionFor(origin, boot.engine)))!,
        {
          messageId: "outside-the-window",
          address: "stranger9@fake.test",
          name: "Stranger 9",
          receivedAt: "2026-08-30T08:00:00.000Z",
          subject: "Older than this mirror keeps",
          snippet: "one line",
        },
      ];
      const rows = liveScreener(pres, view, {}, server).waiting;
      expect(rows.map((r) => r.address)).toEqual(["stranger1@fake.test", "stranger9@fake.test"]);
      const minted = rows[1]!;
      expect(minted.held.map((h) => h.id)).toEqual(["outside-the-window"]);
      // The body it has is a snippet and says so — a decision on a truncation is the risk the
      // Screener exists to remove.
      expect(minted.held[0]!.bodyState).toBe("snippet");
      expect(minted.gatePhysical).toBe(true);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("the read itself", () => {
  it("follows the cursor to the end of the queue", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      for (const n of [1, 2, 3, 4, 5]) held(fake, n, `2026-09-0${n}${"T"}08:00:00.000Z`);
      fake.setScreenerPageSize(2);
      const boot = await bootOn(origin);
      const server = await readScreenerWaiting(sessionFor(origin, boot.engine));
      expect(server!.map((s) => s.address).sort()).toEqual(
        [1, 2, 3, 4, 5].map((n) => `stranger${n}@fake.test`),
      );
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a refusal is NOT an empty queue — the shelf keeps the device's own list and says so", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      for (const n of [1, 2]) held(fake, n);
      const boot = await bootOn(origin);
      fake.failNext("GET", "/screener");
      expect(await readScreenerWaiting(sessionFor(origin, boot.engine))).toBeNull();
      /* …and a `null` answer is what the derivation takes, so the shelf is the partition's own
         list. An empty ARRAY here would have emptied the Screener on a flaky request. */
      const shelf = liveScreener(presentedOf(boot.engine.read(), NOW, false, ANSWERED), view, {}, null);
      expect(shelf.source).toBe("device");
      expect(shelf.waiting).toHaveLength(2);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("both doors ask once per read cadence, and the engine keeps the store's page for the partition", () => {
    const wiring = src("src/state/world.tsx");
    // The standalone door serves `GET /screener` from the engine in this process, so its shelf is
    // the store's too; the old gate that kept it on the partition's own list is gone.
    expect(wiring).toContain("() => void queueRead(() => readScreenerWaiting(session)),");
    expect(wiring).not.toContain("if (!session.standalone) void queueRead(");
    // The engine's own page is armed once per session by the drain read and asked again by its
    // settle (`drain-reads.ts`, driven in `drain-reads.test.ts`), on both doors.
    expect(wiring).toContain("engine: session.engine,");
    expect(src("src/state/drain-reads.ts")).toContain("void engine.refreshScreenerWaiting()");
    // A superseded session's late answer applies nothing, and a swap clears the set.
    expect(wiring).toContain("if (current.current === m) setScreenerServer(ans);");
    expect(wiring).toContain("setScreenerServer(null);");
  });

  it("a device-counted shelf says so on the surface", () => {
    // The meta the Screener renders, and the projection hands it the shelf's own source.
    expect(screenerMetaOf("device", 2, SCREENING_UNSUPPLIED)).toBe("2 first-time senders waiting, counted on this phone");
    expect(screenerMetaOf("server", 2, SCREENING_UNSUPPLIED)).toBe("2 first-time senders waiting");
    expect(src("src/state/world-projection.ts")).toContain("meta: screenerMetaOf(s.source, s.waiting.length, posture, holder),");
  });
});
