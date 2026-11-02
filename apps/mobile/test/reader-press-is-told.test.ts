/**
 * ═══ A READER'S PRESS IS SENT, MARKED, AND ANSWERED ═════════════════════════════════════════════
 *
 * A phone reading a mailbox a desktop organizes offered the Screener's live verbs, closed the
 * sheet on "Ohbox" as if the decision were taken, and said nothing when the organizer refused it.
 * The rule: a press the screen accepts reaches the organizer and is applied, or the reader is told
 * it was not — and nothing on screen says what the phone's state makes false.
 *
 * The decisions are driven (the press over a real wire, the marks and sentences as functions) and
 * the markup is read, for `send-later-not-on-this-phone.test.ts`'s reason: this workspace has no
 * React Native renderer. TO WATCH IT FAIL: in `state/relay.ts`, make `relayMarkFor` return `null`
 * for an in-flight entry and the waiting cases redden while the refused ones stay green.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EngineMessage } from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { readingAtConnectSaid, sayReadingAtConnect } from "../src/engine/organizer-session";
import type { ConnectedSession } from "../src/net/pairing";
import { readRelayedDecisions } from "../src/net/screener";
import { liveActions, liveScreener, presentedOf, type WorldView } from "../src/state/live";
import { relayMarkFor, senderSheetLine, withSentHere, type RelayedDecision } from "../src/state/relay";
import { readingAtConnectLine } from "../src/ui/standalone-form";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(APP, rel), "utf8");
const HOLDER = "zorin-9950";
const SENDER = "b@sender.test";

const sent = (over: Partial<RelayedDecision> = {}): RelayedDecision =>
  ({ subject: SENDER, scope: "sender", state: "sent", refusedReason: null, ...over });

describe("the sender's mark, from this phone's own outstanding decisions", () => {
  it("a decision still with the organizer is marked as sent there, pending or appended", () => {
    for (const state of ["pending", "sent"] as const) {
      expect(relayMarkFor(SENDER, [sent({ state })], HOLDER))
        .toEqual({ kind: "waiting", text: Copy.relayWaiting(HOLDER) });
    }
    expect(relayMarkFor("B@Sender.test", [sent()], null))
      .toEqual({ kind: "waiting", text: Copy.relayWaitingUnknown });
  });

  it("a refusal is told with the organizer's reason, and an unknown one without inventing one", () => {
    const refused = relayMarkFor(SENDER, [sent({ state: "refused", refusedReason: "wrong_mailbox" })], HOLDER);
    expect(refused).toEqual({ kind: "refused", text: Copy.relayRefused(Copy.relayReasonOtherMailbox) });
    expect(relayMarkFor(SENDER, [sent({ state: "refused", refusedReason: "a-newer-word" })], HOLDER))
      .toEqual({ kind: "refused", text: Copy.relayRefusedUnknown });
  });

  it("a second press over a refused one reads as waiting; a domain decision marks its senders", () => {
    const both = [sent({ state: "refused", refusedReason: "stale" }), sent({ state: "pending" })];
    expect(relayMarkFor(SENDER, both, HOLDER)?.kind).toBe("waiting");
    expect(relayMarkFor(SENDER, [sent({ scope: "domain", subject: "sender.test" })], HOLDER)?.kind).toBe("waiting");
  });

  it("POSITIVE CONTROL: nothing outstanding, or somebody else's, marks nothing", () => {
    expect(relayMarkFor(SENDER, null, HOLDER)).toBeNull();
    expect(relayMarkFor(SENDER, [], HOLDER)).toBeNull();
    expect(relayMarkFor(SENDER, [sent({ subject: "other@sender.test" })], HOLDER)).toBeNull();
  });

  it("the press marks the sender at once, replacing an earlier refusal of the same subject", () => {
    const after = withSentHere([sent({ state: "refused", refusedReason: "stale" })], { address: SENDER, scope: "sender" });
    expect(after).toEqual([sent({ state: "pending" })]);
  });
});

describe("the sheet says where a decision goes before it is made", () => {
  it("names the organizer before the press, then the mark, and nothing where this phone decides", () => {
    const organizer = { name: HOLDER, stopped: false };
    expect(senderSheetLine(null, organizer)).toBe(Copy.senderSentThere(HOLDER));
    const waiting = relayMarkFor(SENDER, [sent()], HOLDER);
    expect(senderSheetLine(waiting, organizer)).toBe(Copy.relayWaiting(HOLDER));
    expect(senderSheetLine(null, null)).toBeNull();
    expect(senderSheetLine(null, { name: HOLDER, stopped: true })).toBeNull();
  });

  it("the Screener row and the sheet read the mark and the organizer — the markup, read", () => {
    const shelf = read("app/(tabs)/screener.tsx");
    expect(shelf).toContain("relayMarkFor(row.address, w.screener.relayed, w.mailboxes.organizer?.name ?? null)");
    expect(shelf).toContain("{mark.text}");
    const sheet = read("src/ui/SenderDetail.tsx");
    expect(sheet).toContain("relayMarkFor(row.address, w.screener.relayed, organizer?.name ?? null)");
    expect(sheet).toContain("senderSheetLine(relay, organizer)");
    expect(sheet).toContain("{sheetLine}");
  });

  it("the outstanding decisions are read on BOTH doors, on the queue read's cadence", () => {
    const world = read("src/state/world.tsx");
    expect(world).toContain("() => void relayRead(() => readRelayedDecisions(session)),");
    expect(world, "the relay read sits behind the paired-only gate").not.toContain(
      "if (!session.standalone) void relayRead",
    );
    expect(world).toContain("relayedHere: (decided) => {");
    expect(world).toContain("setRelayed((prev) => withSentHere(prev, decided));");
  });
});

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};
const view: WorldView = { now: new Date("2026-09-26T09:17:17Z"), zone: "UTC" };

describe("the press on a mailbox another install organizes, over a real wire", () => {
  it("says it was SENT to the organizer, marks the sender, and leaves the mail where it is", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("s1", { subject: "Hello", folder: "ohmail/Screener", from: { name: "B", address: SENDER } }));
      const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
      if (boot.kind !== "ready") throw new Error("boot refused");
      await boot.verifyIdentity();
      await boot.engine.start();
      const toasts: string[] = [];
      const relayed: { address: string; scope: string }[] = [];
      const actions = liveActions({
        engine: boot.engine,
        toast: (m) => toasts.push(sayArg(m)),
        relayedHere: (d) => relayed.push(d),
      });
      const row = liveScreener(presentedOf(boot.engine.read(), view.now), view).waiting[0]!;
      fake.queueNextForOrganizer("POST", "/screener/", HOLDER);

      expect(await actions.decide(row, "ohbox", false, "sender")).toBe(false);
      expect(toasts).toContain(Copy.liveDecideSent(HOLDER, SENDER));
      expect(toasts.some((t) => t.startsWith("Ohbox —")), "the press said it filed").toBe(false);
      expect(relayed).toEqual([{ address: SENDER, scope: "sender" }]);
      expect(boot.engine.read().get<EngineMessage>("message", "s1")?.folder).toBe("ohmail/Screener");
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("reads this phone's outstanding decisions off the route, and a refused read as could-not-ask", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.setPendingDecisions([
        { subject: SENDER, scope: "sender", decidedAt: view.now.toISOString(), sent: true, state: "sent", refusedReason: null },
        { subject: "c@sender.test", scope: "sender", state: "refused", refusedReason: "wrong_mailbox" },
        { subject: "", scope: "sender", state: "sent" },
      ]);
      const session = { profile: { origin, apiBase: null }, fetch: (u: string, i?: RequestInit) => globalThis.fetch(u, i) };
      const got = await readRelayedDecisions(session as unknown as ConnectedSession);
      expect(got).toEqual([
        sent(),
        { subject: "c@sender.test", scope: "sender", state: "refused", refusedReason: "wrong_mailbox" },
      ]);
      fake.failNextStatus("GET", "/screener", 503);
      expect(await readRelayedDecisions(session as unknown as ConnectedSession)).toBeNull();
    } finally {
      fake.server.close();
    }
  });
});

describe("at connect, a mailbox another install organizes is said to be read here", () => {
  it("names the organizer, or says another install without inventing a name", () => {
    expect(readingAtConnectLine({ name: HOLDER })).toBe(Copy.readingAtConnect(HOLDER));
    expect(readingAtConnectLine({ name: " " })).toBe(Copy.readingAtConnectUnknown);
    expect(Copy.readingAtConnect(HOLDER)).toContain("This phone reads this mailbox");
  });

  it("the notice stands until dismissed or a later connect is not refused to a holder", () => {
    sayReadingAtConnect({ name: HOLDER });
    expect(readingAtConnectSaid()).toEqual({ name: HOLDER });
    sayReadingAtConnect(null);
    expect(readingAtConnectSaid()).toBeNull();
  });

  it("the connect's consent press records it from a held answer, and the Ohbox renders it — read", () => {
    const conn = read("src/net/connection.tsx");
    expect(conn).toContain(
      'sayReadingAtConnect(outcome.kind === "held" ? { name: outcome.name, consentRecorded: outcome.consentRecorded, joinWaits: outcome.joinWaits } : null);',
    );
    const ohbox = read("app/(tabs)/index.tsx");
    // The recorded answer passes through the live claim, so the card drops once the mailbox is handed back.
    expect(ohbox).toContain("const reading = readingAtConnectNow(w.standalone ? readingAtConnectSaid() : null, claim);");
    expect(ohbox).toContain("{readingAtConnectLine(reading)}");
    expect(ohbox).toContain("onPress={() => sayReadingAtConnect(null)}");
  });
});
