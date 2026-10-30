import { afterEach, describe, expect, it } from "vitest";
import type { WaitingOnOrganizerView } from "@ohmail/client-engine";
import { sayArg } from "../src/refusal";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, liveMessage } from "../src/state/live";
import { waitingRowLines, waitingStripLine } from "../src/ui/waiting-lines";
import { filingStripSaid, filingsGroupSaid, filingsPressSaid, filingsWaiting } from "../src/ui/filing-lines";
import type { PhoneFiling, PhoneMailbox } from "../src/net/mailboxes";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/**
 * THE PHONE LISTS WHAT WAITS ON THE ORGANIZER (gap row NO-STANDING-LIST-OF-WHAT-WAITS-ON-THE-
 * ORGANIZER): the strip's line and the sheet's rows, from the engine's merged list, which the
 * phone's own door forwards from `GET /organizer-requests` — so a repeat press after a relaunch
 * is still answered from the server's record.
 */
const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open, deleteDatabase: world.drop,
  uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })(),
};
const view = (over: Partial<WaitingOnOrganizerView>): WaitingOnOrganizerView => ({
  requestId: "q1", kind: "message.move", state: "sent", holder: { name: "Laptop" }, mailboxId: "mb",
  decidedAt: "2026-10-02T09:00:00.000Z", refusedReason: null, target: { messageId: "m1", folder: "ohmail/News" },
  ruleId: null, messageId: "m1", slow: false, ...over,
});

afterEach(() => { resetLocaleRegisterForTests(); });

describe("the strip and the sheet", () => {
  it("count what is still in flight, name the holder, and say each request", () => {
    const list = [view({}), view({ requestId: "q2", kind: "rule.delete", target: { rule: { kind: "sender", match: "ann@shop.example", subjectContains: null, bodyContains: null } } })];
    expect(waitingStripLine(list)).toBe("2 changes wait on Laptop.");
    expect(list.map((w) => waitingRowLines(w).what)).toEqual(["A message to News", "Remove the rule for ann@shop.example"]);
  });

  it("a refusal is said with its reason, and a slow request says it still waits", () => {
    expect(waitingRowLines(view({ state: "refused", kind: "rule.update", refusedReason: "no_such_rule",
      target: { rule: { kind: "sender", match: "a@b.example", subjectContains: null, bodyContains: null }, destination: "ohmail/Receipts" } })))
      .toEqual({ what: "The rule for a@b.example: files into Receipts", state: "Laptop did not carry this out." });
    expect(waitingRowLines(view({ slow: true })).state).toBe("Still waiting for Laptop.");
    expect(waitingStripLine([view({ state: "refused", refusedReason: "no_such_rule" })])).toBe("Laptop did not carry this out.");
  });

  it("CONTROL: nothing waiting draws nothing; German has its own words", () => {
    expect(waitingStripLine([])).toBeNull();
    setActiveLocale("de");
    expect(waitingStripLine([view({})])).toBe("1 Änderung wartet auf Laptop.");
  });
});

/* FOLDER-MISSING-FILINGS: the phone had no stuck-filing surface at all — a Move into a folder another
   client deleted said done, and nothing anywhere said the server kept the letter in the Inbox. */
describe("the filings that wait: the strip, the block and the presses", () => {
  const NOW = Date.parse("2026-10-24T04:46:00.000Z");
  const quiet: PhoneFiling = { due: 0, deferred: 0, stuck: 0, stuckSince: null, stuckRefusalClass: null, lastRefusalClass: null, nextAttemptAt: null, asOf: null };
  const box = (id: string, filing: Partial<PhoneFiling>, over: Partial<PhoneMailbox> = {}): PhoneMailbox => ({
    id, address: `${id}@example.test`, organizerRole: "organizer", organizeConsentedAt: null, organizedBy: null,
    organizedByThisInstall: true, organizerState: null, status: "connected", junkFolder: null, sentFolder: null, smtpMaxSizeBytes: null,
    firstSyncStopFolder: null, filing: { ...quiet, ...filing }, ...over,
  });
  const stuck = { stuck: 2, due: 2, stuckSince: "2026-10-24T04:02:00.000Z", stuckRefusalClass: "no_such_folder" };

  it("stuck comes first, with how long, which mailbox and the server's reason", () => {
    expect(filingStripSaid([box("m1", stuck)], NOW, "UTC"))
      .toEqual({ title: "2 messages have not been filed for 44 minutes", detail: "m1@example.test · the folder is not there", warn: true, mailboxId: "m1" });
    expect(filingStripSaid([box("m1", { ...stuck, stuckSince: "2026-10-24T01:00:00.000Z" }), box("m2", { stuck: 1, stuckSince: null, stuckRefusalClass: "read_only" })], NOW, "UTC"))
      .toMatchObject({ title: "3 messages have not been filed for 3 hours", detail: "2 mailboxes · the reasons differ by mailbox" });
  });

  it("otherwise the deferred ones wait for the next try; a reader's or a removed mailbox's rows say nothing", () => {
    const waiting = box("m1", { deferred: 1, lastRefusalClass: "refused", nextAttemptAt: "2026-10-24T05:24:00.000Z" });
    expect(filingStripSaid([waiting], NOW, "UTC")).toEqual({
      title: "1 message waits for the next try", detail: "m1@example.test · the last try did not go through · next try at 05:24", warn: false, mailboxId: "m1",
    });
    expect(filingStripSaid([box("m1", stuck, { organizerRole: "reader" }), box("m2", stuck, { status: "disabled" }), box("m3", { due: 4 })], NOW, "UTC")).toBeNull();
    expect(filingStripSaid([box("m1", {}, { filing: undefined })], NOW, "UTC")).toBeNull();
    expect(filingsWaiting(box("m1", { due: 2, deferred: 1 }))).toBe(3);
    expect(filingsWaiting(box("m1", { due: 2 }, { organizerRole: "reader" }))).toBe(0);
  });

  it("a folder's block names where the letters are and why, and offers Leave only where it can settle", () => {
    const g = { folder: "ohmail/Screened", count: 2, deletes: 0, since: "2026-10-24T04:02:00.000Z", through: "2026-10-24T04:06:00.000Z",
      nextAttemptAt: "2026-10-24T05:24:00.000Z", at: "INBOX", reasons: [{ reason: "no_such_folder", count: 2 }] };
    expect(filingsGroupSaid(g, "UTC")).toEqual({
      label: "2 messages wait to be filed into Screened out since 04:02",
      lines: ["Why: the folder is not there", "Next try at 05:24.", "They are in Ohbox on your mail server."],
      leave: true,
    });
    expect(filingsGroupSaid({ ...g, deletes: 2, through: null, reasons: [{ reason: "refused", count: 1 }, { reason: "weird", count: 1 }] }, "UTC"))
      .toMatchObject({ lines: ["Why: the last try did not go through (1), the last try did not go through (1)", "Next try at 05:24.",
        "They are in Ohbox on your mail server.", "You deleted them."], leave: false });
    expect([{ k: "retried", count: 2 }, { k: "left", count: 1 }, { k: "elsewhere" }, { k: "failed" }].map((p) => filingsPressSaid(p as never)))
      .toEqual(["2 messages will be tried again on the next pass.", "1 message stays where it is.",
        "Another install organizes this mailbox now. Nothing was changed.", "That did not go through. Nothing was changed."]);
  });

  it("in the web's words, in English and German", () => {
    const web = (locale: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../webapp/messages/${locale}.json`, import.meta.url)), "utf8")) as
      Record<string, Record<string, string>>;
    for (const locale of ["en", "de"] as const) {
      setActiveLocale(locale);
      const m = web(locale);
      expect(filingsPressSaid({ k: "elsewhere" })).toBe(m.mailboxFilings!.elsewhere);
      expect(filingsPressSaid({ k: "failed" })).toBe(m.mailboxFilings!.failed);
      expect(filingsGroupSaid({ folder: "x", count: 1, deletes: 0, since: null, through: null, nextAttemptAt: null, at: null,
        reasons: [{ reason: "no_such_folder", count: 1 }] }, "UTC").lines).toEqual([m.mailboxFilings!.why!.replace("{reasons}", m.sync!.filingReason_no_such_folder!)]);
    }
    expect(filingStripSaid([box("m1", { deferred: 2, lastRefusalClass: "over_quota" })], NOW, "UTC")!.title).toBe("2 Nachrichten warten auf den nächsten Versuch");
  });
});

describe("the phone's door forwards the list", () => {
  it("the server's record is in the engine's list, and a repeat press after a relaunch is answered from it", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("m1", { subject: "Weekly" }));
    fake.setWaitingRequests([{
      id: "q1", kind: "message.move", state: "sent", mailboxId: "mb1", holder: { name: "Studio laptop" },
      decidedAt: "2026-01-01T00:00:00.000Z", resolvedAt: null, refusedReason: null,
      target: { messageId: "m1", folder: "ohmail/News" },
    }]);
    const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
    if (boot.kind !== "ready") throw new Error("boot refused");
    try {
      await boot.verifyIdentity();
      await boot.engine.start();
      boot.engine.waitingOnOrganizer();
      await new Promise((r) => setTimeout(r, 50));
      expect(boot.engine.waitingOnOrganizer()).toEqual([expect.objectContaining({ requestId: "q1", messageId: "m1", slow: true })]);
      const said: string[] = [];
      const actions = liveActions({ engine: boot.engine, uuid: deps.uuid, zone: "UTC", toast: (m) => void said.push(sayArg(m)) });
      const row = liveMessage(boot.engine, "m1", { now: new Date(), zone: "UTC" })!;
      const before = fake.seen.filter((r) => r.url.endsWith("/move")).length;
      expect(await actions.move(row, "reads")).toBe(true);
      expect(said).toEqual(["Still waiting for Studio laptop."]);
      expect(fake.seen.filter((r) => r.url.endsWith("/move")).length, "a second request went out").toBe(before);
    } finally { boot.store.close(); fake.server.close(); }
  });
});
