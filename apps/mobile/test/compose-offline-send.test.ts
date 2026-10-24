/**
 * OFFLINE, SEND SAYS SO AND ONE LETTER IS ONE DRAFT — the phone's own actions
 * through `bootEngine`, against a fake answering what the phone's engine answers with the network
 * cut (`apps/sidecar/test/phone-offline-send.test.ts` measured it: 500, then 409 `failed`).
 * Measured at the base: every press POSTed a second row, Cancel's keep POSTed a third, and the
 * refusal was a toast drawn under the composer's Modal.
 *
 * The sheet has no React Native renderer here, so its wiring is READ, `compose-keeps-a-draft`'s
 * idiom: the row and the sentence are decided by the functions driven below.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Copy, DECKS } from "../src/copy";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, type LiveWorldActions, type ToastOpts } from "../src/state/live";
import { failedSendLine } from "../src/ui/send-failed";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
/* @reads: apps/mobile/src/ui/MessageActions.tsx */

const SHEET = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/ui/MessageActions.tsx"), "utf8");

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
const peer = [{ name: null, address: "peer@fake.test" }];

const open: { close(): void }[] = [];
afterEach(() => {
  for (const o of open.splice(0)) o.close();
  resetLocaleRegisterForTests();
});

async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "Welcome" }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  open.push({ close: () => { boot.store.close(); fake.server.close(); } });
  const toasts: { say: string; opts?: ToastOpts }[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine, toast: (m, opts) => toasts.push({ say: sayArg(m), ...(opts ? { opts } : {}) }), uuid, zone: "UTC",
  });
  return { fake, ...boot, actions, toasts };
}

const calls = (fake: ReturnType<typeof mailServer>, method: string, path: string) =>
  fake.seen.filter((r) => r.method === method && r.url === path);

describe("a Send refused with the network cut names its row, and the next press is that row", () => {
  it("a new mail: two presses, one row, and the sentence the refusal earned", async () => {
    const live = await scene();
    live.fake.sendOffline();
    const first = await live.actions.sendNew("mb-1", peer, "Coffee?", "Tomorrow at ten?");
    expect(first).toMatchObject({ outcome: "failed", failure: "replyFailed", draftId: "d-1" });
    const second = await live.actions.sendNew("mb-1", peer, "Coffee?", "Tomorrow at eleven?", null, null, [], first.draftId);
    expect(second).toMatchObject({ outcome: "failed", draftId: "d-1" });
    expect(live.fake.draftRows().map((d) => d.id), "a second press of one letter wrote a second draft").toEqual(["d-1"]);
    // The bound press wrote its own words into THAT row before sending it.
    const put = calls(live.fake, "PUT", "/drafts/d-1").at(-1);
    expect(JSON.parse(put!.body)).toMatchObject({ body: "Tomorrow at eleven?", subject: "Coffee?" });
  }, 30_000);

  it("a reply: the second press is the same row, under the parent's envelope", async () => {
    const live = await scene();
    live.fake.sendOffline();
    const first = await live.actions.sendReply("m1", "Thanks", false);
    expect(first.draftId).toBeDefined();
    await live.actions.sendReply("m1", "Thanks!", false, null, null, [], false, first.draftId);
    expect(live.fake.draftRows()).toHaveLength(1);
    expect(JSON.parse(calls(live.fake, "PUT", `/drafts/${first.draftId}`).at(-1)!.body))
      .toMatchObject({ subject: "Re: Welcome", body: "Thanks!" });
  }, 30_000);

  it("Cancel keeps INTO that row, and its Undo throws the one letter away", async () => {
    const live = await scene();
    live.fake.sendOffline();
    const first = await live.actions.sendNew("mb-1", peer, "Coffee?", "Tomorrow at ten?");
    const creates = calls(live.fake, "POST", "/drafts").length;
    const kept = await live.actions.draftKeep({
      mode: "new", messageId: null, mailboxId: "mb-1", to: peer, subject: "Coffee?", body: "Tomorrow at ten?",
      files: 0, draftId: first.draftId,
    });
    expect(kept).toBe("kept");
    expect(calls(live.fake, "POST", "/drafts"), "the keep created a second row").toHaveLength(creates);
    expect(live.fake.draftRows()).toHaveLength(1);
    const said = live.toasts.at(-1)!;
    expect(said.say).toBe(Copy.composeKept);
    said.opts!.undo!();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls(live.fake, "DELETE", "/drafts/d-1")).toHaveLength(1);
  }, 30_000);

  it("CONTROL: once the network is back, the bound press sends the one row", async () => {
    const live = await scene();
    live.fake.sendOffline();
    const first = await live.actions.sendNew("mb-1", peer, "Coffee?", "Tomorrow at ten?");
    live.fake.sendOffline(false);
    const sent = await live.actions.sendNew("mb-1", peer, "Coffee?", "Tomorrow at ten?", null, null, [], first.draftId);
    expect(sent.outcome).toBe("sent");
    expect(sent.draftId, "a delivered send named a row to bind").toBeUndefined();
    expect(live.fake.deliveries()).toHaveLength(1);
    expect(live.fake.draftRows()).toHaveLength(1);
  }, 30_000);
});

describe("the refusal is said in the composer, above its buttons", () => {
  const lost = { kind: "lost" } as const;
  it("names the offline fact only where the phone's own verdict says it and the row is kept", () => {
    for (const locale of ["en", "de"] as const) {
      setActiveLocale(locale);
      expect(failedSendLine("replyFailed", lost, true), locale).toBe(DECKS[locale].composeNotSentOffline);
      expect(failedSendLine("replyFailed", { kind: "gone", since: "09:00" }, true)).toBe(DECKS[locale].composeNotSentOffline);
      // CONTROLS: reachable, no verdict, or no row kept — the refusal's own sentence.
      expect(failedSendLine("replyFailed", { kind: "reachable" }, true)).toBe(DECKS[locale].replyFailed);
      expect(failedSendLine("replyFailed", null, true)).toBe(DECKS[locale].replyFailed);
      expect(failedSendLine("replyFailed", lost, false)).toBe(DECKS[locale].replyFailed);
      // A server that answered (a refused sign-in) was reached, whatever the verdict says.
      expect(failedSendLine("replyLoginRefused", lost, true)).toBe(DECKS[locale].replyLoginRefused);
    }
  });

  it("the sheet binds the row, passes it to every send and to the keep, and renders the line", () => {
    const send = SHEET.slice(SHEET.indexOf("const send = async ("), SHEET.indexOf("return (\n    <Modal"));
    for (const verb of ["sendNew(", "sendForward(", "sendReply("]) {
      const call = send.slice(send.indexOf(verb), send.indexOf(")", send.indexOf(verb)));
      expect(call, `${verb} does not carry the bound row`).toContain("draftId");
    }
    expect(send).toContain("if (result.outcome === \"failed\" && result.draftId) setDraftId(result.draftId);");
    expect(send).toContain("if (result.outcome === \"failed\" && result.failure) setFailNote(result.failure);");
    const close = SHEET.slice(SHEET.indexOf("const closeComposer = () => {"), SHEET.indexOf("const send = async ("));
    expect(close).toMatch(/files, dropped, draftId,/);
    // Inside the sheet, as an alert, BEFORE the button row — never a toast under the Modal.
    const line = SHEET.indexOf("failedSendLine(failNote, w.boot.connection, draftId !== null)");
    expect(line).toBeGreaterThan(-1);
    expect(SHEET.slice(SHEET.lastIndexOf("<Txt", line), line)).toContain('accessibilityRole="alert"');
    expect(line).toBeLessThan(SHEET.indexOf('<Button label={Copy.replyCancel} variant="quiet" onPress={closeComposer} style={{ marginRight: "auto" }} />'));
  });
});
