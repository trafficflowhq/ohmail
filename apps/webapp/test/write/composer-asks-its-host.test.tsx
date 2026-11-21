/** @vitest-environment jsdom */
/**
 * WHAT THE COMPOSER ASKS OF WHOEVER MOUNTS IT, AND NOTHING ELSE OF A SHELL: it holds no setter of a shell's open
 * state and hands no ref up. A reply that opens names its letter to the host (which shows it where the reply would
 * otherwise stand unseen); a send that leaves the compose form names its list with no letter open, in one ask; a
 * reply draft opened from a list names its letter, to be opened with its reply. Each host answers in its own
 * layout: today's shell with its reading sheet below the column's width, the mail ground with the frame's commands.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import { COMPOSE_SEND_KEY } from "@ohmail/app-logic/writing/mail-send";
import { act, message, replyDraft, stubDom, waitFor } from "../_draft-shell.js";
import { letter } from "../_handoff-steps.js";
import { mountWriting, rounds, unmountWritings } from "../_write-1-writing.js";

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* storage blocked */
  }
  stubDom();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});
afterEach(async () => {
  await unmountWritings();
  resetComposerForTest();
});

describe("what the composer asks of its host", () => {
  it("a reply and a forward that open name their letter to the host, once each", async () => {
    const w = await mountWriting({ messages: [message("m1"), message("m2")], hash: "#/ohbox" });
    await act(async () => w.now().openReply("m1"));
    await rounds(4);
    expect(w.replyTo()).toBe("m1");
    expect(w.asked).toEqual(["show m1"]);
    await act(async () => w.now().openForward("m2"));
    await rounds(4);
    expect(w.replyTo()).toBe("m2");
    expect(w.asked).toEqual(["show m1", "show m2"]);
  });

  it("a send that clears the compose form leaves for its list with no letter open, in one ask", async () => {
    const row = letter("d-a", "Plans for Friday", "Shall we meet at noon?");
    const w = await mountWriting({ drafts: [row] });
    await act(async () => w.now().openDraft(row));
    await rounds(6);
    w.asked.length = 0;
    await act(async () => w.now().sendCompose());
    /* The form says Sent for a moment, then clears: that is when the composer leaves for its list. */
    await waitFor(() => w.sent.some((m) => m.kind === "mail_send"), "the send to reach the wire");
    await waitFor(() => w.now().mailSend.stateOf(COMPOSE_SEND_KEY).phase === "idle", "the form to clear", 400);
    expect(w.sent.filter((m) => m.kind === "mail_send")).toHaveLength(1);
    expect(w.asked).toEqual(["go ohbox open:null"]);
  });

  it("a reply draft opened from a list names its letter, to be opened with its reply; no ref is handed up", async () => {
    const draft = replyDraft("d-r", "m1", "Noon suits me.");
    const w = await mountWriting({ messages: [message("m1")], drafts: [draft], hash: "#/drafts" });
    expect("openMessageRef" in w.now(), "the composer still hands a ref up to its host").toBe(false);
    await act(async () => w.now().openDraft(draft));
    await rounds(6);
    expect(w.asked).toEqual(["open-with-reply m1"]);
    expect(w.replyTo()).toBe("m1");
    expect(w.now().replyBody.text).toBe("Noon suits me.");
  });
});
