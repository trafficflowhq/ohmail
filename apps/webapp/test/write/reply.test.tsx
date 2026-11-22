/** @vitest-environment jsdom */
/**
 * THE REPLY OVER TODAY'S COMPOSITION: `write`'s reply sheet (the reader's slot, with the plain editor) drawn on the
 * composer record through `writingOf`. It stands only under the letter it answers; its people are folded into the
 * names the send goes to until they are changed; it leaves once however Send is pressed; a forward names nobody
 * until the person does, and a flagged letter is asked about first; offline it is kept and says so; Discard closes
 * it with its Undo.
 */
import { Blob as NodeBlob } from "node:buffer";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { MutationRejectedError } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import en from "../../messages/en.json";
import { act, message, replyDraft, stubDom, waitFor } from "../_draft-shell.js";
import type { DraftReplyWire } from "@ohmail/app-logic/writing/draft-reply";
import { mountWriting, rounds, unmountWritings, type WritingWorld } from "../_write-1-writing.js"; // Write over parts that stay (share write-1): today's words and keys leave

const W = en.write;

beforeEach(() => {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
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

const sendButton = (): HTMLButtonElement =>
  within(screen.getByRole("toolbar", { name: W.verbs })).getByRole("button", { name: W.send }) as HTMLButtonElement;
const sends = (w: WritingWorld) =>
  w.sent.filter((m) => m.kind === "mail_send") as unknown as {
    inReplyTo?: string | null;
    forwardOf?: string;
    body: string;
    to?: { address: string }[];
    cc?: { address: string }[];
  }[];

async function open(
  how: "reply" | "forward",
  messages: EngineMessage[] = [message("m1")],
  sheet = ["m1"],
  more: { draftWire?: DraftReplyWire; metered?: boolean; noCredits?: boolean } = {},
) {
  const w = await mountWriting({ messages, hash: "#/ohbox", sheet, ...more });
  await act(async () => (how === "reply" ? w.now().openReply("m1") : w.now().openForward("m1")));
  await rounds(6);
  return w;
}

/** The Tiptap editor behind Write's rich text box (ProseMirror's view stamps it on its own element). */
type RichBox = { editor?: { chain(): { selectAll(): { insertContent(w: string): { run(): boolean } } }; getText(): string } };

/**
 * A person writes `words` in place of what the box held. Write's text is the ground's rich editor (a
 * contenteditable, as every host mounts it): the words go in where the person's typing puts them, over a whole
 * selection; a line of the head (a plain field) takes them as before.
 */
async function write(name: string, words: string): Promise<void> {
  const box = (await screen.findByRole("textbox", { name })) as HTMLElement & RichBox;
  await act(async () => {
    if (box.editor) box.editor.chain().selectAll().insertContent(words).run();
    else fireEvent.change(box, { target: { value: words } });
  });
  await rounds(2);
}

async function person(line: string, address: string): Promise<void> {
  const typed = screen.getByRole("combobox", { name: line }) // a line that offers people is a combobox;
  await act(async () => {
    fireEvent.change(typed, { target: { value: address } });
  });
  await act(async () => {
    fireEvent.keyDown(typed, { key: "Enter" });
  });
  await rounds(2);
}

describe("the reply's sheet", () => {
  it("stands only under the letter it answers", async () => {
    await open("reply", [message("m1"), message("m2")], ["m2"]);
    expect(screen.queryByRole("region", { name: W.reply.label.replace("{name}", "The colleague") })).toBeNull();
    expect(screen.queryByRole("textbox", { name: W.reply.text })).toBeNull();
  });

  it("folds its people into the name the send goes to, and leaves once however Send is pressed", async () => {
    const w = await open("reply");
    expect(screen.getByRole("region", { name: W.reply.label.replace("{name}", "The colleague") })).toBeTruthy();
    expect(screen.getByText("The colleague")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: W.to })).toBeNull();
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
    expect(sendButton().title).toBe(en.compose.needContent);
    await act(async () => { fireEvent.click(sendButton()); });
    expect(sends(w)).toEqual([]);
    await write(W.reply.text, "Noon works for me.");
    w.sendGate.wait = new Promise(() => undefined);
    await act(async () => {
      fireEvent.click(sendButton());
      fireEvent.click(sendButton());
    });
    const text = screen.getByRole("textbox", { name: W.reply.text });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        fireEvent.keyDown(text, { key: "Enter", ctrlKey: true, repeat: i > 0 });
      });
    }
    await rounds(10);
    expect(sends(w)).toHaveLength(1);
    expect(sends(w)[0]).toMatchObject({ inReplyTo: "m1", body: "Noon works for me." });
    expect(sendButton().disabled).toBe(true);
  });

  it("unfolds into three lines seeded with whom the fold named; the send goes to the lines as changed", async () => {
    const w = await open("reply");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: W.reply.change }));
    });
    await rounds(2);
    expect(screen.getByRole("group", { name: W.to }).textContent).toContain("The colleague");
    await person(W.cc, "lena@example.invalid");
    await write(W.reply.text, "Adding Lena.");
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(10);
    expect(sends(w)).toHaveLength(1);
    expect(sends(w)[0]!.cc?.map((p) => p.address)).toEqual(["lena@example.invalid"]);
  });

  it("sends the edited quoted history in both body formats", async () => {
    const w = await open("reply", [message("m1", { body: "The original wording." })]);
    const box = await screen.findByRole("textbox", { name: W.reply.text }) as HTMLElement & { editor: TiptapEditor };
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: W.reply.change }));
    });
    await rounds(2);
    expect(screen.getByRole("group", { name: W.to }).textContent).toContain("The colleague");
    await person(W.cc, "lena@example.invalid");
    await write(W.reply.text, "Adding Lena.");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: W.history.show })); });
    const original = await screen.findByText(/The original wording/);
    const text = Array.from(original.childNodes).find((node) => node.textContent === "The original wording.")!;
    const start = box.editor.view.posAtDOM(text, 0);
    await act(async () => {
      box.editor.chain().setTextSelection({ from: start, to: start + "The original wording.".length })
        .insertContent("The edited wording.").run();
    });
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(10);
    expect(sends(w)).toHaveLength(1);
    expect(sends(w)[0]!.cc?.map((p) => p.address)).toEqual(["lena@example.invalid"]);
    expect(sends(w)[0]).toMatchObject({
      inReplyTo: "m1",
      body: expect.stringContaining("The edited wording."),
      html: expect.stringContaining("The edited wording."),
    });
    expect(sends(w)[0]?.body).not.toContain("The original wording.");
  });

  it("says an inline quote edit could not be saved and keeps the edit", async () => {
    const w = await open("reply");
    const mutate = w.engine.mutate.bind(w.engine);
    let refused = false;
    w.engine.mutate = async (mutation, options) => {
      if (mutation.kind !== "draft_save") return mutate(mutation, options);
      refused = true;
      return { id: "refused", key: "refused", status: "rolled_back", seq: null,
        error: new MutationRejectedError("The server did not save the edited quoted history.", {
          code: "draft_unsaved", retryable: false,
        }),
      };
    };
    const box = await screen.findByRole("textbox", { name: W.reply.text }) as HTMLElement & { editor: TiptapEditor };
    const html = '<p>My reply</p><blockquote data-quoted-history="edited"><p>My edited quote</p></blockquote>';
    await act(async () => { box.editor.commands.setContent(html, { emitUpdate: true }); });
    await waitFor(() => refused, "the draft save was refused");
    expect(screen.getByText(en.compose.draftNotSaved)).toBeTruthy();
    expect(w.now().replyBody.html).toBe(html);
  });

  it("sends the destination's original after pasting from a folded forward", async () => {
    const { FIXED_NOW, makeDeps, seedSession, seedMailbox, seedMessage, seedBody } =
      await import("../../../../packages/api/test/helpers.js");
    const { dbFor, draftsService, sendService } = await import("@trafficflow/services/mail");
    // PGlite's template uses the Node Blob API, which jsdom's Blob does not implement.
    vi.stubGlobal("Blob", NodeBlob);
    const { db } = await makeDeps(FIXED_NOW).finally(() => vi.unstubAllGlobals());
    const account = await seedSession(db, { now: FIXED_NOW });
    const recipient = ["forward-recipient", "example.invalid"].join("@");
    const mailboxId = await seedMailbox(db, { accountId: account.accountId, address: recipient });
    const original = await seedMessage(db, { accountId: account.accountId, mailboxId, subject: "Destination letter",
      fromAddress: recipient, date: FIXED_NOW, nativeLocator: { folder: "INBOX", ref: "7:2" } });
    await seedBody(db, { messageId: original.id, text: "Destination original wording." });

    const source = await open("forward", [message("m1", { body: "Source original wording." })]);
    const sourceBox = await screen.findByRole("textbox", { name: W.reply.forwardText }) as HTMLElement & { editor: TiptapEditor };
    await write(W.reply.forwardText, "Shared visible note.");
    await act(async () => { sourceBox.editor.chain().selectAll().toggleBold().run(); });
    fireEvent.click(screen.getByRole("button", { name: W.history.show }));
    await screen.findByText(/Source original wording/);
    fireEvent.click(screen.getByRole("button", { name: W.history.hide }));
    await act(async () => { sourceBox.editor.commands.selectAll(); });
    const clipboard = new Map<string, string>();
    fireEvent(sourceBox, Object.assign(new Event("copy", { bubbles: true, cancelable: true }), {
      clipboardData: { clearData: () => clipboard.clear(), setData: (kind: string, value: string) => clipboard.set(kind, value) },
    }));
    expect(clipboard.get("text/html")).toContain("data-pm-slice");
    expect(clipboard.get("text/html")).toContain("<strong>Shared visible note.</strong>");
    expect(clipboard.get("text/plain")).toBe("Shared visible note.");
    expect(clipboard.get("text/html")).not.toContain("Source original wording.");
    await source.unmount();

    const destination = await mountWriting({ messages: [message(original.id, { body: "Destination original wording." })],
      hash: "#/ohbox", sheet: [original.id] });
    await act(async () => { destination.now().openForward(original.id); });
    const box = await screen.findByRole("textbox", { name: W.reply.forwardText });
    fireEvent(box, Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
      clipboardData: { types: [...clipboard.keys()], getData: (kind: string) => clipboard.get(kind) ?? "" },
    }));
    await person(W.to, recipient);
    await act(async () => { fireEvent.click(sendButton()); });
    await waitFor(() => destination.sent.some((mutation) => mutation.kind === "mail_send"), "the forward was pressed");
    const outgoing = destination.sent.find((mutation) => mutation.kind === "mail_send")!;
    expect(outgoing.html).toContain("<strong>Shared visible note.</strong>");
    expect(outgoing.forwardOf).toBe(original.id);
    expect(outgoing.html ?? "").not.toContain("data-quoted-history");

    const ctx = { db: dbFor(db, account.accountId), accountId: account.accountId, userId: account.userId,
      now: () => FIXED_NOW, requestId: "clipboard-forward" };
    const draft = await draftsService.create(ctx, { mailboxId, subject: outgoing.subject!,
      forwardOfMessageId: original.id, to: outgoing.to!, ...(outgoing.html ? { html: outgoing.html } : { body: outgoing.body }) });
    const delivered: Array<{ text?: string; html?: string }> = [];
    const sent = await sendService.send(ctx, draft.draft.id, "clipboard-forward", {
      openSendAdapter: async () => ({
        async send(value) { delivered.push(value); return { providerMessageId: value.messageId! }; },
        async messageInSent() { return false; },
        async close() {},
      }),
    }, { forwardOf: original.id });
    expect(sent.status).toBe("sent");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain("Shared visible note.");
    expect(delivered[0]?.text).toContain("Destination original wording.");
    expect(delivered[0]?.text).not.toContain("Source original wording.");
    expect(delivered[0]?.html).toContain("<strong>Shared visible note.</strong>");
    expect(delivered[0]?.html).toContain("Destination original wording.");
    expect(delivered[0]?.html).not.toContain("Source original wording.");
  }, 30_000);

  it("a reply-all folds into everyone the send goes to, the person's own address left out", async () => {
    const letter = message("m1", {
      to: [
        { address: "me@example.invalid", name: "Me" },
        { address: "lena@example.invalid", name: "Lena" },
      ],
      cc: [{ address: "max@example.invalid", name: "Max" }],
    } as Partial<EngineMessage>);
    const w = await mountWriting({ messages: [letter], hash: "#/ohbox", sheet: ["m1"] });
    await act(async () => w.now().openReply("m1", true));
    await rounds(6);
    expect(screen.getByText("The colleague, Lena · Cc Max")).toBeTruthy();
    await write(W.reply.text, "Noon for all of us.");
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(10);
    expect(sends(w)).toHaveLength(1);
    expect(sends(w)[0]!.to?.map((p) => p.address)).toEqual(["colleague@example.invalid", "lena@example.invalid"]);
    expect(sends(w)[0]!.cc?.map((p) => p.address)).toEqual(["max@example.invalid"]);
  });

  it("a forward names nobody: Send rests until a person is in To, then one send carries the original", async () => {
    const w = await open("forward");
    expect(screen.queryByText("The original message is added when you send.")).toBeNull();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: W.subject }).readOnly).toBe(true);
    await write(W.reply.forwardText, "For your files.");
    expect(sendButton().disabled).toBe(true);
    await person(W.to, "lena@example.invalid");
    expect(sendButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(10);
    expect(sends(w)).toHaveLength(1);
    expect(sends(w)[0]).toMatchObject({ forwardOf: "m1", body: "For your files." });
    expect(sends(w)[0]!.to?.map((p) => p.address)).toEqual(["lena@example.invalid"]);
  });

  it("a forward of a letter ohmail flagged asks first: nothing is written or sent until Forward", async () => {
    const flagged = message("m1", { sensitivity: { no_forward: true, category: "otp" } } as Partial<EngineMessage>);
    const w = await open("forward", [flagged]);
    expect(screen.getByRole("alertdialog", { name: W.reply.ask.question }).textContent).toContain(W.reply.ask.otp);
    expect(screen.queryByRole("textbox", { name: W.reply.forwardText })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: W.reply.ask.confirm }));
    });
    await rounds(4);
    expect(screen.getByRole("textbox", { name: W.reply.forwardText })).toBeTruthy();
    expect(sends(w)).toHaveLength(0);
  });

  it("offline, keeps the reply and says it goes once the connection is back", async () => {
    const w = await open("reply");
    await write(W.reply.text, "Written on the train.");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    w.offline.on = true;
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(20);
    expect(screen.getByRole("status").textContent).toContain(W.status.offline);
    expect(replyText()).toBe(
      "Written on the train.",
    );
  });

  it("Discard closes it at once, and its Undo opens it again with its words", async () => {
    const w = await open("reply");
    await write(W.reply.text, "Not yet.");
    await rounds(4);
    await act(async () => {
      fireEvent.click(within(screen.getByRole("toolbar", { name: W.verbs })).getByRole("button", { name: W.discard }));
    });
    await rounds(6);
    expect(w.replyTo()).toBeNull();
    expect(screen.queryByRole("textbox", { name: W.reply.text })).toBeNull();
    const said = w.reports.find((r) => r.message === en.compose.toastDiscard);
    await act(async () => said!.options!.onAction!());
    await rounds(6);
    expect(replyText()).toBe("Not yet.");
    expect(sends(w)).toHaveLength(0);
  });
});

/** The drafter's wire: every purchase with its key, each answered by the gate the case holds. */
function drafter(fromText: "door" | "none" = "door") {
  const bought: { messageId: string; key: string }[] = [];
  const fromWords: { body: unknown; key: string }[] = [];
  const state = { gate: null as Promise<void> | null };
  const wire: DraftReplyWire = {
    configured: () => true,
    create: async (messageId, key) => {
      bought.push({ messageId, key });
      if (state.gate) await state.gate;
      return { draftId: "d-drafted" };
    },
    read: async (draftId) =>
      draftId === "d-words"
        ? { body: "Drafted from your words: noon suits me.", html: null }
        : { body: "Drafted: noon suits me.", html: null },
    fromText:
      fromText === "none"
        ? "none"
        : async (body, key) => {
            fromWords.push({ body, key });
            if (state.gate) await state.gate;
            return { draftId: "d-words" };
          },
  };
  return { wire, bought, fromWords, state };
}
const draftButton = (label: string): HTMLButtonElement => screen.getByRole("button", { name: label }) as HTMLButtonElement;
/** The words the reply's text box shows (Write's rich editor: its text). */
const replyText = (): string => {
  const box = screen.getByRole("textbox", { name: W.reply.text }) as HTMLElement & RichBox;
  if (!box.editor) throw new Error("the reply's text box is no rich editor");
  return box.editor.getText();
};

describe("draft reply in one press", () => {
  it("says its price before the press, buys once however often pressed while it runs, and lands in the reply", async () => {
    const d = drafter();
    const w = await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    expect(draftButton(W.draft.verb).title).toContain("15");
    expect(document.body.textContent).toContain("15 credits");
    expect(d.bought).toEqual([]);
    let release = (): void => undefined;
    d.state.gate = new Promise((r) => (release = r));
    await act(async () => {
      fireEvent.click(draftButton(W.draft.verb));
    });
    await act(async () => {
      fireEvent.click(draftButton(W.draft.running));
    });
    expect(d.bought).toHaveLength(1);
    expect(d.bought[0]!.messageId).toBe("m1");
    await act(async () => release());
    await rounds(10);
    expect(replyText()).toBe("Drafted: noon suits me.");
    expect(sends(w)).toHaveLength(0);
  });

  it("over typed words, the draft takes their place and the person's own text is one tab away; Send sends the one shown", async () => {
    /* A host with no door for drafting from the person's words: the plain Draft reply over typed words. */
    const d = drafter("none");
    const w = await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    await write(W.reply.text, "My own words.");
    await act(async () => {
      fireEvent.click(draftButton(W.draft.verb));
    });
    await rounds(10);
    expect(replyText()).toBe("Drafted: noon suits me.");
    expect(screen.getByRole("button", { name: W.draft.draft }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: W.draft.yours }));
    });
    await rounds(4);
    expect(replyText()).toBe("My own words.");
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(10);
    expect(sends(w)).toHaveLength(1);
    expect(sends(w)[0]!.body).toBe("My own words.");
    expect(d.bought).toHaveLength(1);
  });

  it("where drafting is not charged, no price is said", async () => {
    const d = drafter();
    await open("reply", [message("m1")], ["m1"], { draftWire: d.wire, metered: false });
    expect(draftButton(W.draft.verb).title).toBe(W.draft.verb);
    expect(document.body.textContent).not.toContain("credits");
  });

  it("a forward offers no draft", async () => {
    const d = drafter();
    await open("forward", [message("m1")], ["m1"], { draftWire: d.wire });
    expect(screen.queryByRole("button", { name: W.draft.verb })).toBeNull();
  });
});

describe("draft from your text", () => {
  it("while the reply holds typed words the control says so, with its price; nothing is asked before the press", async () => {
    const d = drafter();
    await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    expect(screen.queryByRole("button", { name: W.draft.fromText })).toBeNull();
    await write(W.reply.text, "noon ok, bring the glaze");
    expect(draftButton(W.draft.fromText).title).toContain("15");
    expect(document.body.textContent).toContain("15 credits");
    expect(d.fromWords).toEqual([]);
    expect(d.bought).toEqual([]);
  });

  it("one press drafts from those words for this letter, once however often pressed while it runs", async () => {
    const d = drafter();
    const w = await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok, bring the glaze");
    let release = (): void => undefined;
    d.state.gate = new Promise((r) => (release = r));
    await act(async () => {
      fireEvent.click(draftButton(W.draft.fromText));
    });
    await act(async () => {
      fireEvent.click(draftButton(W.draft.running));
    });
    expect(d.fromWords).toEqual([
      { body: { text: "noon ok, bring the glaze", inReplyToMessageId: "m1" }, key: d.fromWords[0]!.key },
    ]);
    expect(d.bought).toEqual([]);
    await act(async () => release());
    await rounds(10);
    expect(replyText()).toBe("Drafted from your words: noon suits me.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: W.draft.yours }));
    });
    await rounds(4);
    expect(replyText()).toBe("noon ok, bring the glaze");
    expect(sends(w)).toHaveLength(0);
  });

  it("a second press after the draft landed is a new purchase under a new key", async () => {
    const d = drafter();
    await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok");
    await act(async () => {
      fireEvent.click(draftButton(W.draft.fromText));
    });
    await rounds(10);
    await act(async () => {
      fireEvent.click(draftButton(W.draft.again));
    });
    await rounds(10);
    expect(d.fromWords).toHaveLength(2);
    expect(d.fromWords[1]!.body).toEqual({ text: "noon ok", inReplyToMessageId: "m1" });
    expect(d.fromWords[1]!.key).not.toBe(d.fromWords[0]!.key);
  });

  it("where the host has no door for it the word is not drawn: the plain control stands and nothing is asked", async () => {
    const d = drafter("none");
    await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok, bring the glaze");
    expect(screen.queryByRole("button", { name: W.draft.fromText })).toBeNull();
    expect(draftButton(W.draft.verb)).toBeTruthy();
    expect(d.fromWords).toEqual([]);
    expect(d.bought).toEqual([]);
  });

  it("an empty balance the host knows of is said before the press, with no price", async () => {
    const d = drafter();
    await open("reply", [message("m1")], ["m1"], { draftWire: d.wire, noCredits: true });
    await write(W.reply.text, "noon ok");
    expect(document.body.textContent).toContain(W.draft.noCredits);
    expect(document.body.textContent).not.toContain("15 credits");
    expect(draftButton(W.draft.fromText).title).toBe(W.draft.fromText);
    expect(d.fromWords).toEqual([]);
  });

  it("a host that hands no draft wire (the demo) draws no draft control: no Draft reply, no Draft from your text", async () => {
    await open("reply");
    await write(W.reply.text, "noon ok, bring the glaze");
    expect(screen.queryByRole("button", { name: W.draft.verb })).toBeNull();
    expect(screen.queryByRole("button", { name: W.draft.fromText })).toBeNull();
    expect(document.body.textContent).not.toContain("15 credits");
  });

  it("on another letter while a draft is being written, the control says it waits and a press asks nothing", async () => {
    const d = drafter();
    const w = await open("reply", [message("m1"), message("m2")], ["m1", "m2"], { draftWire: d.wire });
    let release = (): void => undefined;
    d.state.gate = new Promise((r) => (release = r));
    await act(async () => {
      fireEvent.click(draftButton(W.draft.verb));
    });
    await act(async () => w.now().openReply("m2"));
    await rounds(6);
    const waiting = draftButton(W.draft.waiting);
    expect(waiting.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(waiting);
    });
    expect(d.bought).toHaveLength(1);
    expect(d.fromWords).toEqual([]);
    await act(async () => release());
    await rounds(10);
  });
});

/** A drafter whose every purchase answers a draft of its own: "first draft", "second draft", ...; `gate` holds the next. */
function serial(fromText: "door" | "none" = "door") {
  const asked: { kind: "reply" | "words"; key: string; body?: unknown; messageId?: string }[] = [];
  const state = { gate: null as Promise<void> | null };
  let n = 0;
  const names = ["first draft", "second draft", "third draft", "fourth draft", "fifth draft"];
  const wire: DraftReplyWire = {
    configured: () => true,
    create: async (messageId, key) => {
      asked.push({ kind: "reply", key, messageId });
      n += 1;
      const mine = n;
      if (state.gate) await state.gate;
      return { draftId: `d-${mine}` };
    },
    read: async (draftId) => ({ body: names[Number(draftId.slice(2)) - 1] ?? "?", html: null }),
    fromText:
      fromText === "none"
        ? "none"
        : async (body, key) => {
            asked.push({ kind: "words", key, body });
            n += 1;
            const mine = n;
            if (state.gate) await state.gate;
            return { draftId: `d-${mine}` };
          },
  };
  return { wire, asked, state };
}
const press = async (label: string, settle = 10): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: label }));
  });
  await rounds(settle);
};

describe("the person's own text, one tab away", () => {
  it("Draft again keeps the person's own words one tab away", async () => {
    const d = serial();
    await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok");
    await press(W.draft.fromText);
    expect(replyText()).toBe("first draft");
    await press(W.draft.again);
    expect(d.asked.map((a) => a.kind)).toEqual(["words", "words"]);
    expect(replyText()).toBe("second draft");
    await press(W.draft.yours, 4);
    expect(replyText()).toBe("noon ok");
  });

  it("Draft again keeps the person's own words one tab away where the host has no door for drafting from them", async () => {
    const d = serial("none");
    await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok");
    await press(W.draft.verb);
    expect(replyText()).toBe("first draft");
    await press(W.draft.again);
    expect(d.asked.map((a) => a.kind)).toEqual(["reply", "reply"]);
    expect(replyText()).toBe("second draft");
    await press(W.draft.yours, 4);
    expect(replyText()).toBe("noon ok");
  });

  it("the reply closed and opened again keeps the person's own words one tab away", async () => {
    const d = serial();
    const w = await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok");
    await press(W.draft.fromText);
    expect(replyText()).toBe("first draft");
    await act(async () => w.now().closeReply());
    await rounds(8);
    expect(screen.queryByRole("textbox", { name: W.reply.text })).toBeNull();
    await act(async () => w.now().openReply("m1"));
    await rounds(8);
    expect(replyText()).toBe("first draft");
    await press(W.draft.yours, 4);
    expect(replyText()).toBe("noon ok");
  });

  it("a discarded reply lets its own text go: opened again, it has no Your text", async () => {
    const d = serial();
    const w = await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok");
    await press(W.draft.fromText);
    expect(screen.getByRole("button", { name: W.draft.yours })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(screen.getByRole("toolbar", { name: W.verbs })).getByRole("button", { name: W.discard }));
    });
    await rounds(6);
    await act(async () => w.now().openReply("m1"));
    await rounds(8);
    expect(replyText()).toBe("");
    expect(screen.queryByRole("button", { name: W.draft.yours })).toBeNull();
  });

  it.each([
    ["Your text", "yours", "noon ok"],
    ["the draft's tab", "draft", "third draft"],
  ] as const)(
    "after Draft, Draft again, a tab switch and Draft again, a Send from %s sends exactly its words",
    async (_name, tab, words) => {
      const d = serial();
      const w = await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
      await write(W.reply.text, "noon ok");
      await press(W.draft.fromText);
      await press(W.draft.again);
      await press(W.draft.yours, 4);
      expect(replyText()).toBe("noon ok");
      await press(W.draft.draft, 4);
      expect(replyText()).toBe("second draft");
      await press(W.draft.again);
      expect(replyText()).toBe("third draft");
      // Every purchase was made of the person's own words, never of a draft.
      expect(d.asked.map((a) => a.body)).toEqual([
        { text: "noon ok", inReplyToMessageId: "m1" },
        { text: "noon ok", inReplyToMessageId: "m1" },
        { text: "noon ok", inReplyToMessageId: "m1" },
      ]);
      if (tab === "yours") await press(W.draft.yours, 4);
      expect(replyText()).toBe(words);
      await act(async () => {
        fireEvent.click(sendButton());
      });
      await rounds(10);
      expect(sends(w)).toHaveLength(1);
      expect(sends(w)[0]!.body).toBe(words);
    },
  );
});

/** The reply on `id` again, the one open closed first. */
const reopen = async (w: WritingWorld, id: string): Promise<void> => {
  await act(async () => w.now().closeReply());
  await rounds(6);
  await act(async () => w.now().openReply(id));
  await rounds(8);
};
/** The draft control's label as drawn, of those named. */
const drawnOf = (labels: readonly string[]): string[] =>
  labels.filter((l) => screen.queryByRole("button", { name: l }) !== null);

describe("the person's own text is kept per letter: a draft on another letter between", () => {
  it("a draft on another letter over no words leaves this reply's own text one tab away", async () => {
    const d = serial();
    const w = await open("reply", [message("m1"), message("m2")], ["m1", "m2"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok");
    await press(W.draft.fromText);
    expect(replyText()).toBe("first draft");
    expect(screen.queryByRole("button", { name: W.draft.yours })).not.toBeNull();
    await reopen(w, "m2");
    expect(replyText()).toBe("");
    await press(W.draft.verb);
    expect(replyText()).toBe("second draft");
    await reopen(w, "m1");
    expect(replyText()).toBe("first draft");
    expect(screen.queryByRole("button", { name: W.draft.yours })).not.toBeNull();
  });

  it("a draft over typed words on another letter leaves this reply's own text one tab away", async () => {
    const d = serial();
    const w = await open("reply", [message("m1"), message("m2")], ["m1", "m2"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok");
    await press(W.draft.fromText);
    await reopen(w, "m2");
    await write(W.reply.text, "thanks");
    await press(W.draft.fromText);
    expect(replyText()).toBe("second draft");
    await reopen(w, "m1");
    expect(screen.queryByRole("button", { name: W.draft.yours })).not.toBeNull();
  });

  it("back on the first letter Draft again buys a draft of the person's words, and a Send from Your text carries them", async () => {
    const d = serial();
    const w = await open("reply", [message("m1"), message("m2")], ["m1", "m2"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok");
    await press(W.draft.fromText);
    await reopen(w, "m2");
    await press(W.draft.verb);
    await reopen(w, "m1");
    const label = drawnOf([W.draft.again, W.draft.fromText, W.draft.verb])[0]!;
    await press(label);
    expect(replyText()).toBe("third draft");
    await press(W.draft.yours, 4);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(10);
    expect(sends(w)).toHaveLength(1);
    expect({ pressed: label, purchase: d.asked[2]?.body ?? d.asked[2]?.kind, sent: sends(w)[0]!.body }).toEqual({
      pressed: W.draft.again,
      purchase: { text: "noon ok", inReplyToMessageId: "m1" },
      sent: "noon ok",
    });
  });

  it("the same where the host has no door for drafting from the person's words: Your text never holds the model's", async () => {
    const d = serial("none");
    const w = await open("reply", [message("m1"), message("m2")], ["m1", "m2"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok");
    await press(W.draft.verb);
    expect(replyText()).toBe("first draft");
    await reopen(w, "m2");
    await press(W.draft.verb);
    await reopen(w, "m1");
    const label = drawnOf([W.draft.again, W.draft.verb])[0]!;
    await press(label);
    expect(replyText()).toBe("third draft");
    await press(W.draft.yours, 4);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(10);
    expect({ pressed: label, sent: sends(w)[0]?.body }).toEqual({ pressed: W.draft.again, sent: "noon ok" });
  });

  it.each([
    ["Your text", "yours", ["see you friday", "noon ok", "second draft"]],
    ["the draft's tab", "draft", ["third draft", "fourth draft", "second draft"]],
  ] as const)(
    "three letters, drafts bought in turn with a letter switch between: a Send from %s carries each letter's own words",
    async (_name, tab, sent) => {
      const d = serial();
      const three = [message("m1"), message("m2"), message("m3")];
      const w = await open("reply", three, ["m1", "m2", "m3"], { draftWire: d.wire });
      await write(W.reply.text, "noon ok");
      await press(W.draft.fromText);
      await reopen(w, "m2");
      await press(W.draft.verb);
      expect(screen.queryByRole("button", { name: W.draft.yours })).toBeNull();
      await reopen(w, "m3");
      await write(W.reply.text, "see you friday");
      await press(W.draft.fromText);
      await reopen(w, "m1");
      expect(replyText()).toBe("first draft");
      await press(W.draft.again);
      expect(replyText()).toBe("fourth draft");
      // Every purchase was made of exactly the words its letter's person typed, or of none.
      expect(d.asked.map((a) => a.body ?? `${a.kind} ${a.messageId}`)).toEqual([
        { text: "noon ok", inReplyToMessageId: "m1" },
        "reply m2",
        { text: "see you friday", inReplyToMessageId: "m3" },
        { text: "noon ok", inReplyToMessageId: "m1" },
      ]);
      for (const id of ["m3", "m1", "m2"]) {
        await reopen(w, id);
        if (id !== "m2" && tab === "yours") await press(W.draft.yours, 4);
        if (id === "m2") expect({ shown: replyText(), yours: screen.queryByRole("button", { name: W.draft.yours }) }).toEqual({
          shown: "second draft", yours: null,
        });
        await act(async () => {
          fireEvent.click(sendButton());
        });
        await rounds(10);
      }
      expect(sends(w).map((s) => s.body)).toEqual(sent);
    },
  );
});

describe("the person's own text: a draft over no words, and a discard", () => {
  it("a plain draft into an empty reply: the control over it reads Draft again, never Draft from your text", async () => {
    const d = serial();
    await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    await press(W.draft.verb);
    expect(replyText()).toBe("first draft");
    expect(drawnOf([W.draft.again, W.draft.fromText, W.draft.verb])).toEqual([W.draft.again]);
  });

  it("...pressed, it is a plain draft again and Your text never holds the model's words", async () => {
    const d = serial();
    await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    await press(W.draft.verb);
    const label = drawnOf([W.draft.again, W.draft.fromText, W.draft.verb])[0]!;
    await press(label);
    const yours = screen.queryByRole("button", { name: W.draft.yours });
    expect({ pressed: label, asked: d.asked.map((a) => a.kind), tabs: yours !== null, shown: replyText() }).toEqual({
      pressed: W.draft.again,
      asked: ["reply", "reply"],
      tabs: false,
      shown: "second draft",
    });
  });

  it("a reply discarded while its draft is out does not bring the discarded words back as Your text", async () => {
    const d = serial();
    const w = await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok");
    let release = (): void => undefined;
    d.state.gate = new Promise((r) => (release = r));
    await act(async () => {
      fireEvent.click(draftButton(W.draft.fromText));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("toolbar", { name: W.verbs })).getByRole("button", { name: W.discard }));
    });
    await rounds(6);
    expect(w.replyTo()).toBeNull();
    await act(async () => release());
    await rounds(12);
    const shown = screen.queryByRole("textbox", { name: W.reply.text }) === null ? null : replyText();
    expect({ shown, yours: screen.queryByRole("button", { name: W.draft.yours }) !== null }).toEqual({
      shown: "first draft",
      yours: false,
    });
  });

  it("Discard, then its Undo: the reply comes back with its draft and Your text one tab away", async () => {
    const d = serial();
    const w = await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok");
    await press(W.draft.fromText);
    await act(async () => {
      fireEvent.click(within(screen.getByRole("toolbar", { name: W.verbs })).getByRole("button", { name: W.discard }));
    });
    await rounds(6);
    const said = w.reports.find((r) => r.message === en.compose.toastDiscard);
    await act(async () => said!.options!.onAction!());
    await rounds(6);
    expect({ shown: replyText(), yours: screen.queryByRole("button", { name: W.draft.yours }) !== null }).toEqual({
      shown: "first draft",
      yours: true,
    });
    await press(W.draft.yours, 4);
    expect(replyText()).toBe("noon ok");
  });

  it("Discard while its draft is out, then the Undo before it lands: the words put back stay one tab away", async () => {
    const d = serial();
    const w = await open("reply", [message("m1")], ["m1"], { draftWire: d.wire });
    await write(W.reply.text, "noon ok");
    let release = (): void => undefined;
    d.state.gate = new Promise((r) => (release = r));
    await act(async () => {
      fireEvent.click(draftButton(W.draft.fromText));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("toolbar", { name: W.verbs })).getByRole("button", { name: W.discard }));
    });
    await rounds(6);
    const closed = w.replyTo() === null;
    const said = w.reports.find((r) => r.message === en.compose.toastDiscard);
    await act(async () => said!.options!.onAction!());
    await rounds(6);
    const undone = replyText();
    await act(async () => release());
    await rounds(12);
    const shown = replyText();
    const yours = screen.queryByRole("button", { name: W.draft.yours }) !== null;
    if (yours) await press(W.draft.yours, 4);
    expect({ closed, undone, shown, yours, own: yours ? replyText() : null }).toEqual({
      closed: true,
      undone: "noon ok",
      shown: "first draft",
      yours: true,
      own: "noon ok",
    });
    expect(d.asked.map((a) => a.body)).toEqual([{ text: "noon ok", inReplyToMessageId: "m1" }]);
  });

  it("an earlier send of the letter settling after another of its drafts was opened lets go none of that draft's words", async () => {
    const d = serial();
    const first = replyDraft("r-first", "m1", "The first answer");
    const second = { ...replyDraft("r-second", "m1", "A second answer"), updatedAt: "2026-09-27T08:41:00.000Z" };
    const w = await mountWriting({
      messages: [message("m1")], drafts: [first, second], hash: "#/ohbox", sheet: ["m1"], draftWire: d.wire,
    });
    await act(async () => w.now().openDraft(first));
    await rounds(8);
    expect(replyText()).toBe("The first answer");
    let sent = (): void => undefined;
    w.sendGate.wait = new Promise((r) => (sent = r));
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(6);
    await act(async () => w.now().openDraft(second));
    await rounds(8);
    expect(replyText()).toBe("A second answer");
    let release = (): void => undefined;
    d.state.gate = new Promise((r) => (release = r));
    await act(async () => {
      fireEvent.click(draftButton(W.draft.fromText));
    });
    // The first send settles (past its sent beat) while the second row's draft is out.
    await act(async () => sent());
    await rounds(180);
    await act(async () => release());
    await rounds(12);
    const yours = screen.queryByRole("button", { name: W.draft.yours }) !== null;
    if (yours) await press(W.draft.yours, 4);
    expect({
      sent: sends(w).map((s) => s.body),
      asked: d.asked.map((a) => a.body),
      yours,
      own: yours ? replyText() : null,
    }).toEqual({
      sent: ["The first answer"],
      asked: [{ text: "A second answer", inReplyToMessageId: "m1" }],
      yours: true,
      own: "A second answer",
    });
  });
});
