/**
 * TYPED TEXT IS NEVER LOST SILENTLY — a closing composer keeps what was written as a draft, on a
 * real wire. Measured at the base: closing the sheet (a stray tap on the backdrop is enough) called
 * `onClose()` with the text on screen, nothing reached `POST /drafts`, and no Drafts row existed.
 *
 * The keep is `draftKeep` driven through the app's own `bootEngine` against the loopback server;
 * the close's decision lives in `src/ui/compose-keep.ts` (no React Native renderer here —
 * `send-cancel.ts`'s idiom) and the sheet is READ to prove every road out takes it.
 *
 * To watch it fail: `keepAct` answering "close" for text (the defect itself), or the sheet's
 * `closeComposer` not consulting it — each is a case below.
 */
/* @reads: apps/mobile/src/ui/MessageActions.tsx */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, type LiveWorldActions, type ToastOpts } from "../src/state/live";
import { keepAct, unmountKeep, worthKeeping } from "../src/ui/compose-keep";
import { DRAFT_BODY_MAX_BYTES } from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const SHEET = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/ui/MessageActions.tsx"), "utf8");

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };

async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "Welcome" }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: { say: string; opts?: ToastOpts }[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine, toast: (m, opts) => toasts.push({ say: sayArg(m), ...(opts ? { opts } : {}) }), uuid, zone: "UTC",
  });
  return { fake, ...boot, actions, toasts };
}

const posted = (fake: ReturnType<typeof mailServer>) =>
  fake.seen.filter((r) => r.method === "POST" && r.url === "/drafts").map((r) => JSON.parse(r.body) as Record<string, unknown>);

describe("a closed composer keeps its text as a draft", () => {
  it("a reply is kept under its parent, with the envelope the send would derive", async () => {
    const live = await scene();
    const out = await live.actions.draftKeep({
      mode: "reply", messageId: "m1", mailboxId: null, to: [], subject: "", body: "Half a thought", files: 0,
    });
    expect(out).toBe("kept");
    const [row] = posted(live.fake);
    expect(row).toMatchObject({
      mailboxId: "mb-1", inReplyToMessageId: "m1", subject: "Re: Welcome", body: "Half a thought",
      to: [{ name: "Test Sender", address: "sender@fake.test" }],
    });
    expect(live.fake.draftRows()).toHaveLength(1);
    const said = live.toasts.at(-1)!;
    expect(said.say).toBe(Copy.composeKept);
    // The Undo is the one explicit way to throw it away: it discards the row just kept.
    said.opts!.undo!();
    await new Promise((r) => setTimeout(r, 50));
    expect(live.fake.seen.some((r) => r.method === "DELETE" && r.url === "/drafts/d-1")).toBe(true);
  }, 30_000);

  it("a new mail keeps the addresses that parse, its subject and its body", async () => {
    const live = await scene();
    const out = await live.actions.draftKeep({
      mode: "new", messageId: null, mailboxId: "mb-1",
      to: [{ name: null, address: "peer@fake.test" }], subject: "Coffee?", body: "", files: 0,
    });
    expect(out).toBe("kept");
    expect(posted(live.fake)[0]).toMatchObject({
      mailboxId: "mb-1", subject: "Coffee?", to: [{ name: null, address: "peer@fake.test" }],
    });
    expect(posted(live.fake)[0]!.inReplyToMessageId ?? null).toBeNull();
  }, 30_000);

  it("a forward keeps its note under Fwd: and names the message it forwards, and says the files were not kept", async () => {
    const live = await scene();
    await live.actions.draftKeep({
      mode: "forward", messageId: "m1", mailboxId: null,
      to: [{ name: null, address: "peer@fake.test" }], subject: "", body: "FYI", files: 2,
    });
    expect(posted(live.fake)[0]).toMatchObject({ subject: "Fwd: Welcome", body: "FYI" });
    expect(posted(live.fake)[0]!.forwardOfMessageId, "the kept forward names no original").toBe("m1");
    expect(posted(live.fake)[0]!.inReplyToMessageId ?? null, "a forward was kept as a reply").toBeNull();
    expect(live.toasts.at(-1)!.say).toBe(Copy.composeKeptWithoutFiles);
  }, 30_000);

  it("REFUSED — a save the server rejects is not called kept", async () => {
    const live = await scene();
    live.fake.failNext("POST", "/drafts");
    const out = await live.actions.draftKeep({
      mode: "reply", messageId: "m1", mailboxId: null, to: [], subject: "", body: "Still here", files: 0,
    });
    expect(out).toBe("refused");
    expect(live.toasts.some((t) => t.say === Copy.composeKept)).toBe(false);
    expect(live.fake.draftRows()).toHaveLength(0);
  }, 30_000);
});

describe("every road out of the sheet asks before it closes", () => {
  it("text is kept, files alone are asked about, and the second close discards", () => {
    const worth = worthKeeping({ fresh: false, subject: "", body: "x" });
    expect(keepAct({ phase: "idle", worth, files: 0, armed: false })).toBe("keep");
    expect(keepAct({ phase: "idle", worth: false, files: 1, armed: false })).toBe("ask");
    expect(keepAct({ phase: "idle", worth: false, files: 1, armed: true })).toBe("close");
    expect(keepAct({ phase: "idle", worth, files: 0, armed: true })).toBe("close");
    // CONTROL: an empty composer just closes, and a queued send already carries its text.
    expect(keepAct({ phase: "idle", worth: false, files: 0, armed: false })).toBe("close");
    expect(keepAct({ phase: "queued", worth, files: 0, armed: false })).toBe("close");
  });

  it("a recipient or a reply's subject alone is not something the person wrote", () => {
    expect(worthKeeping({ fresh: true, subject: "Hi", body: "" })).toBe(true);
    expect(worthKeeping({ fresh: false, subject: "Re: x", body: " " })).toBe(false);
    expect(worthKeeping({ fresh: true, subject: "", body: "" })).toBe(false);
  });

  it("the backdrop, the back gesture and Cancel are ONE close, and it consults the keep", () => {
    expect(SHEET).toContain("onRequestClose={closeComposer}");
    expect(SHEET).toContain("<SheetBackdrop label={Copy.replyCancel} onPress={closeComposer} />");
    expect(SHEET).toContain('<Button label={Copy.replyCancel} variant="quiet" onPress={closeComposer} style={{ marginRight: "auto" }} />');
    const close = SHEET.slice(SHEET.indexOf("const closeComposer = () => {"), SHEET.indexOf("const send = async ("));
    expect(close).toContain("keepAct({");
    expect(close).toContain("w.actions.draftKeep({");
    // The close waits for the keep: `leave` (the close that calls `onClose`) follows a "kept" answer.
    expect(close).toContain('if (kept === "kept") leave();');
  });
});

describe("past the draft limit the composer says so, and nothing typed is lost unsaid", () => {
  const over = `${"é".repeat(DRAFT_BODY_MAX_BYTES / 2)}x`;
  const at = "é".repeat(DRAFT_BODY_MAX_BYTES / 2);

  it("a close over too long a text stays and says why; the second close discards", () => {
    expect(keepAct({ phase: "idle", worth: true, files: 0, armed: false, tooLong: true })).toBe("tooLong");
    expect(keepAct({ phase: "idle", worth: true, files: 0, armed: true, tooLong: true })).toBe("close");
    // Control: nothing written, nothing to say.
    expect(keepAct({ phase: "idle", worth: false, files: 0, armed: false, tooLong: true })).toBe("close");
    expect(unmountKeep({ phase: "idle", worth: true, keeping: false, tooLong: true })).toBe("nothing");
    expect(unmountKeep({ phase: "idle", worth: true, keeping: false, tooLong: false })).toBe("keep");
  });

  it("draftKeep answers tooLong before the wire, and on the server's 413; exactly at the limit it keeps", async () => {
    const live = await scene();
    const keep = (body: string) => live.actions.draftKeep({
      mode: "reply", messageId: "m1", mailboxId: null, to: [], subject: "", body, files: 0,
    });
    expect(await keep(over)).toBe("tooLong");
    expect(posted(live.fake), "an over-limit keep reached the wire").toHaveLength(0);
    live.fake.answerNext("POST", "/drafts", 413, { error: { code: "draft_too_large", message: "too large", retryable: false } });
    expect(await keep("Fits here, not there")).toBe("tooLong");
    expect(await keep(at)).toBe("kept");
  }, 30_000);

  it("the sheet says the limit while typing and on the close, and a refused quiet save is owed again", () => {
    expect(SHEET).toContain("const tooLong = draftOverCeiling(body);");
    expect(SHEET).toContain("{Copy.composeTooLong(draftLimitLabel())}");
    expect(SHEET).toContain("Copy.composeKeepTooLongBound(draftLimitLabel())");
    const close = SHEET.slice(SHEET.indexOf("const closeComposer = () => {"), SHEET.indexOf("const send = async ("));
    expect(close).toContain('if (act === "tooLong") {');
    expect(close).toContain('setKeepNote(kept === "tooLong" ? "tooLong" : "failed");');
    // The autosave skips past the limit, moves `saved` only once the row holds the words
    // (`autosaveKeep`, kept-draft-edited-on-the-phone.test.ts), and carries one save per snapshot.
    const auto = SHEET.slice(SHEET.indexOf("const savingFor = useRef"), SHEET.indexOf("THE ROW WAS SENT OR DELETED ON ANOTHER DEVICE"));
    expect(auto).toContain('saved.current === onScreen || tooLong) return;');
    expect(auto).toContain("if (savingFor.current === onScreen) return;");
    expect(auto).toContain("autosaveKeep(saved, onScreen,");
    expect(auto).not.toContain("saved.current = onScreen;");
  });
});
