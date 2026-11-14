/** @vitest-environment jsdom */
/**
 * THE NEW LETTER OVER TODAY'S COMPOSITION: `write`'s Letter (with the plain editor) drawn on the composer record
 * through `writingOf`. A letter leaves once however Send is pressed; a refused recipient is said before Send and Send
 * rests; the words typed in the new view are the composition's, kept across a remount; offline, the letter waits
 * and says so.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { setFormatWords } from "@ohmail/app-logic/text";
import { readComposeDraft, resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import { COMPOSE_ATTACH_MAX_TOTAL_BYTES, type ImageQualityLevel } from "@ohmail/client-engine";
import en from "../../messages/en.json";
import { act, message, stubDom } from "../_draft-shell.js";
import { letter } from "../_handoff-steps.js";
import type { DraftReplyWire } from "@ohmail/app-logic/writing/draft-reply";
import { mountWriting, rounds, unmountWritings, type WritingWorld } from "../_write-1-writing.js"; // Write over parts that stay (share write-1): today's words and keys leave

const W = en.write;

/* Write's text is the ground's rich editor (ProseMirror): a drop asks the page which place is under the pointer,
   which every browser answers and jsdom does not. Nothing is under it here. */
if (typeof document.elementFromPoint !== "function") document.elementFromPoint = () => null;

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
const sends = (w: WritingWorld): number => w.sent.filter((m) => m.kind === "mail_send").length;
const sendAnnouncements = () => within(letterRegion()).getAllByRole("status")
  .map((status) => status.textContent)
  .filter((text) => text === W.status.sending || text === W.status.offline);

/** The Tiptap editor behind Write's rich text box (ProseMirror's view stamps it on its own element). */
type RichBox = HTMLElement & {
  editor?: { chain(): { selectAll(): { insertContent(w: string): { run(): boolean } } }; getText(): string };
};
/** The letter's text box: the ground's rich editor, as every host mounts it. */
function richText(): NonNullable<RichBox["editor"]> {
  const box = screen.getByRole("textbox", { name: W.text }) as RichBox;
  if (!box.editor) throw new Error("the letter's text box is no rich editor");
  return box.editor;
}
/** A person writes `words` in place of what the letter's text held (over a whole selection). */
const writeText = (words: string): void => void richText().chain().selectAll().insertContent(words).run();

async function typeLetter(to: string, body: string): Promise<void> {
  const typed = screen.getByRole("combobox", { name: W.to }) // the To line offers people: a combobox;
  await act(async () => {
    fireEvent.change(typed, { target: { value: to } });
  });
  await act(async () => {
    fireEvent.keyDown(typed, { key: "Enter" });
  });
  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: W.subject }), { target: { value: "Friday" } });
  });
  await act(async () => {
    writeText(body);
  });
  await rounds(2);
}

describe("the new letter", () => {
  it("leaves once: a double press on Send and a held Mod+Enter put one send on the wire", async () => {
    const w = await mountWriting({ view: true });
    await typeLetter("lena@example.invalid", "Shall we meet at noon?");
    w.sendGate.wait = new Promise(() => undefined);
    await act(async () => {
      fireEvent.click(sendButton());
      fireEvent.click(sendButton());
    });
    const text = screen.getByRole("textbox", { name: W.text });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        fireEvent.keyDown(text, { key: "Enter", ctrlKey: true, repeat: i > 0 });
      });
    }
    await rounds(10);
    expect(sends(w)).toBe(1);
    expect(sendButton().disabled).toBe(true);
    expect(sendAnnouncements()).toEqual([W.status.sending]);
  });

  it("Mod+Enter from the subject sends once, however long it is held", async () => {
    const w = await mountWriting({ view: true });
    await typeLetter("lena@example.invalid", "From the subject line.");
    const subject = screen.getByRole("textbox", { name: W.subject });
    w.sendGate.wait = new Promise(() => undefined);
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        fireEvent.keyDown(subject, { key: "Enter", ctrlKey: true, repeat: i > 0 });
      });
    }
    await rounds(10);
    expect(sends(w)).toBe(1);
  });

  it("Escape from a field leaves the letter and sends nothing", async () => {
    const w = await mountWriting({ view: true });
    await typeLetter("lena@example.invalid", "Kept for later.");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: W.subject }), { key: "Escape" });
    });
    await rounds(4);
    expect(window.location.hash).not.toBe("#/compose");
    expect(sends(w)).toBe(0);
  });

  it("says a refused recipient under the people before Send, marks it, and Send rests", async () => {
    const w = await mountWriting({ view: true });
    await typeLetter("petra@makersfest", "Hello");
    expect(screen.getByText(W.refused.replace("{list}", "petra@makersfest"))).toBeTruthy();
    expect(screen.getByRole("button", { name: "petra@makersfest" }).getAttribute("aria-invalid")).toBe("true");
    expect(sendButton().disabled).toBe(true);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(4);
    expect(sends(w)).toBe(0);
  });

  it("keeps the words typed in the new view in the composition: they stand after a remount", async () => {
    const w = await mountWriting({ view: true });
    await typeLetter("lena@example.invalid", "Words worth keeping.");
    expect(readComposeDraft("acc-1")?.body).toBe("Words worth keeping.");
    await w.unmount();
    await mountWriting({ view: true, store: w.store });
    await rounds(4);
    expect(richText().getText()).toBe("Words worth keeping.");
  });

  it("draws the sender's signature under the text; written over in place, the send carries the new words", async () => {
    const w = await mountWriting({ view: true, signatures: { mb1: "Lena\nMakers Fest" } });
    await typeLetter("lena@example.invalid", "See you there.");
    const signed = screen.getByRole("textbox", { name: W.signature.label });
    expect(signed.textContent).toBe("Lena\nMakers Fest");
    await act(async () => {
      signed.textContent = "Lena, on the road";
      fireEvent.blur(signed);
    });
    await rounds(2);
    expect(w.now().compose.sig).toEqual({ kind: "edited", text: "Lena, on the road" });
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(10);
    const sent = w.sent.find((m) => m.kind === "mail_send") as { body?: string } | undefined;
    expect(sent?.body).toContain("Lena, on the road");
    expect(sent?.body).not.toContain("Makers Fest");
  });

  it("a signature written over and sent by Mod+Enter from inside it: the send carries the words on screen", async () => {
    const w = await mountWriting({ view: true, signatures: { mb1: "Lena\nMakers Fest" } });
    await typeLetter("lena@example.invalid", "See you there.");
    const signed = screen.getByRole("textbox", { name: W.signature.label });
    await act(async () => {
      signed.focus();
      signed.textContent = "Lena, on the road";
      fireEvent.input(signed);
    });
    await act(async () => {
      fireEvent.keyDown(signed, { key: "Enter", ctrlKey: true });
    });
    await rounds(10);
    expect(sends(w)).toBe(1);
    const wire = JSON.stringify(w.sent.find((m) => m.kind === "mail_send"));
    expect(wire).toContain("Lena, on the road");
    expect(wire).not.toContain("Makers Fest");
  });

  it("a signature written over and left by Escape from inside it: the kept letter keeps the words on screen", async () => {
    const w = await mountWriting({ view: true, signatures: { mb1: "Lena\nMakers Fest" } });
    await typeLetter("lena@example.invalid", "See you there.");
    const signed = screen.getByRole("textbox", { name: W.signature.label });
    await act(async () => {
      signed.focus();
      signed.textContent = "Lena, on the road";
      fireEvent.input(signed);
    });
    await act(async () => {
      fireEvent.keyDown(signed, { key: "Escape" });
    });
    await rounds(10);
    expect(window.location.hash).not.toBe("#/compose");
    expect(readComposeDraft("acc-1")?.sig).toEqual({ kind: "edited", text: "Lena, on the road" });
    expect(sends(w)).toBe(0);
  });

  it("takes the signature off this letter alone", async () => {
    const w = await mountWriting({ view: true, signatures: { mb1: "Lena" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: W.signature.remove }));
    });
    await rounds(2);
    expect(w.now().compose.sig).toEqual({ kind: "removed" });
    expect(screen.queryByRole("textbox", { name: W.signature.label })).toBeNull();
  });

  it("a formatted signature is drawn as it is sent and takes no keys until Edit as text, which says what it costs", async () => {
    const w = await mountWriting({
      view: true,
      signatures: { mb1: "Lena\nMakers Fest" },
      signaturesHtml: { mb1: "<p><strong>Lena</strong><br>Makers Fest</p>" },
    });
    expect(screen.queryByRole("textbox", { name: W.signature.label })).toBeNull();
    const drawn = screen.getByRole("group", { name: W.signature.label });
    expect(drawn.textContent).toContain("Makers Fest");
    expect(w.now().compose.sig ?? { kind: "following" }).toEqual({ kind: "following" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: W.signature.editAsTextHint }));
    });
    await rounds(2);
    const field = screen.getByRole("textbox", { name: W.signature.label });
    expect(field.textContent).toBe("Lena\nMakers Fest");
    expect(w.now().compose.sig).toEqual({ kind: "edited", text: "Lena\nMakers Fest" });
  });

  it("a signature written down to nothing stays, empty; typed again it keeps the new words, and a send carries none", async () => {
    const w = await mountWriting({ view: true, signatures: { mb1: "Lena\nMakers Fest" } });
    await typeLetter("lena@example.invalid", "See you there.");
    const signed = screen.getByRole("textbox", { name: W.signature.label });
    await act(async () => {
      signed.focus();
      signed.textContent = "";
      fireEvent.input(signed);
    });
    await rounds(2);
    expect(screen.getByRole("textbox", { name: W.signature.label })).toBe(signed);
    await act(async () => {
      signed.textContent = "Max";
      fireEvent.input(signed);
    });
    await rounds(2);
    expect(screen.getByRole("textbox", { name: W.signature.label }).textContent).toBe("Max");
    expect(w.now().compose.sig).toEqual({ kind: "edited", text: "Max" });
    /* Written down to nothing and left: the field stays, empty, and the letter goes with no signature. */
    await act(async () => {
      signed.textContent = "";
      fireEvent.input(signed);
    });
    await act(async () => {
      signed.blur();
    });
    await rounds(2);
    expect(screen.getByRole("textbox", { name: W.signature.label }).textContent).toBe("");
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(10);
    const sent = w.sent.find((m) => m.kind === "mail_send") as { body?: string } | undefined;
    expect(sent?.body).toContain("See you there.");
    expect(sent?.body).not.toContain("Makers Fest");
    expect(sent?.body).not.toContain("Max");
  });

  it("offline, keeps the letter and says it goes once the connection is back", async () => {
    const w = await mountWriting({ view: true });
    await typeLetter("lena@example.invalid", "Written on the train.");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    w.offline.on = true;
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(20);
    expect(sendAnnouncements()).toEqual([W.status.offline]);
    expect(richText().getText()).toBe("Written on the train.");
  });
});

/* ---------------------------------------------------------------- files */

const bytes = (n: number, fill: number): Uint8Array<ArrayBuffer> => new Uint8Array(new ArrayBuffer(n)).fill(fill);
const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const letterRegion = (): HTMLElement => screen.getAllByRole("region", { name: W.letter }).at(-1)!;
/** Files let go over the letter: on its text, inside the letter's one landmark (the sheet that names it). */
async function drop(...files: File[]): Promise<void> {
  await act(async () => {
    fireEvent.drop(within(letterRegion()).getByRole("textbox", { name: W.text }), { dataTransfer: { types: ["Files"], files } });
  });
  await rounds(6);
}
const attached = (w: WritingWorld) => w.now().compose.attachments ?? [];
const sentFiles = (w: WritingWorld): readonly { filename: string; contentBase64: string }[] => {
  const send = w.sent.find((m) => m.kind === "mail_send") as { attachments?: { filename: string; contentBase64: string }[] };
  return send.attachments ?? [];
};

/** An encoder of the case's own: a picture keeps a share of its bytes by level; `gate` holds every encode. */
function encoder(stored: ImageQualityLevel) {
  const state = { level: stored, gate: null as Promise<void> | null };
  const share: Record<ImageQualityLevel, number> = { low: 4, medium: 3, high: 2, original: 1 };
  return {
    state,
    port: {
      level: () => state.level,
      setLevel: (l: ImageQualityLevel) => void (state.level = l),
      compress: async (file: Blob, l: ImageQualityLevel) => {
        if (state.gate) await state.gate;
        if (l === "original" || !file.type.startsWith("image/")) return { blob: file, contentType: file.type };
        const all = new Uint8Array(
          await new Promise<ArrayBuffer>((done) => {
            const reader = new FileReader();
            reader.onload = () => done(reader.result as ArrayBuffer);
            reader.readAsArrayBuffer(file);
          }),
        );
        return { blob: new Blob([all.slice(0, Math.ceil(all.length / share[l]))], { type: file.type }), contentType: file.type };
      },
    },
  };
}

describe("the letter's files", () => {
  it("a dropped file lands on the letter and goes with its one send", async () => {
    const w = await mountWriting({ view: true });
    await typeLetter("lena@example.invalid", "The plan is attached.");
    await drop(new File([bytes(1200, 7)], "plan.pdf", { type: "application/pdf" }));
    expect(attached(w).map((a) => a.filename)).toEqual(["plan.pdf"]);
    expect(screen.getByRole("button", { name: W.files.remove.replace("{filename}", "plan.pdf") })).toBeTruthy();
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(10);
    expect(sends(w)).toBe(1);
    expect(sentFiles(w).map((a) => [a.filename, a.contentBase64])).toEqual([["plan.pdf", b64(bytes(1200, 7))]]);
  });

  it("the same file twice stays one file, and says so", async () => {
    const w = await mountWriting({ view: true });
    await drop(new File([bytes(300, 1)], "a.txt", { type: "text/plain" }));
    await drop(new File([bytes(300, 1)], "a.txt", { type: "text/plain" }));
    expect(attached(w)).toHaveLength(1);
    expect(screen.getByText(W.files.twice.replace("{filenames}", "a.txt"))).toBeTruthy();
  });

  it("a file over the ceiling is refused with the ceiling said, and the letter keeps what it had", async () => {
    const w = await mountWriting({ view: true });
    await drop(new File([bytes(100, 2)], "small.txt", { type: "text/plain" }));
    await drop(new File([bytes(COMPOSE_ATTACH_MAX_TOTAL_BYTES, 3)], "huge.bin", { type: "application/octet-stream" }));
    expect(attached(w).map((a) => a.filename)).toEqual(["small.txt"]);
    expect(document.body.textContent).toContain(W.files.refused.split("{size}")[0]!);
  });

  it("Send waits while a file is still being read, and says which", async () => {
    const enc = encoder("original");
    let release!: () => void;
    enc.state.gate = new Promise((r) => (release = r));
    const w = await mountWriting({ view: true, pictures: enc.port });
    await typeLetter("lena@example.invalid", "A photo follows.");
    await drop(new File([bytes(800, 9)], "photo.jpg", { type: "image/jpeg" }));
    expect(sendButton().disabled).toBe(true);
    expect(document.body.textContent).toContain("Still attaching photo.jpg.");
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(4);
    expect(sends(w)).toBe(0);
    release();
    await rounds(8);
    expect(attached(w).map((a) => a.filename)).toEqual(["photo.jpg"]);
    expect(sendButton().disabled).toBe(false);
  });

  it("a quality move re-encodes the pictures on the letter from the picked bytes: Original gives them back whole", async () => {
    const enc = encoder("high");
    const w = await mountWriting({ view: true, pictures: enc.port });
    const picked = bytes(900, 5);
    await drop(new File([picked], "view.png", { type: "image/png" }));
    expect(attached(w)[0]!.contentBase64).toBe(b64(picked.slice(0, 450)));
    const choose = async (word: string): Promise<void> => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: W.files.qualityLabel }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitemradio", { name: word }));
      });
      await rounds(8);
    };
    await choose(W.files.level.low);
    expect(attached(w)[0]!.contentBase64).toBe(b64(picked.slice(0, 225)));
    expect(enc.state.level).toBe("low");
    await choose(W.files.level.original);
    expect(attached(w)[0]!.contentBase64).toBe(b64(picked));
    expect(document.body.textContent).toContain(W.files.qualityScope);
  });
});

/* ---------------------------------------------------------------- send later, from */

const verb = (name: string): HTMLButtonElement =>
  within(screen.getByRole("toolbar", { name: W.verbs })).getByRole("button", { name }) as HTMLButtonElement;

describe("send later", () => {
  it("a picked time goes as one send carrying that time, and nothing else leaves", async () => {
    const w = await mountWriting({ view: true });
    await typeLetter("lena@example.invalid", "For the morning.");
    await act(async () => {
      fireEvent.click(verb(W.later.verb));
    });
    const tomorrow = screen.getByRole("menuitem", { name: /^Tomorrow morning/ });
    await act(async () => {
      fireEvent.click(tomorrow);
    });
    await rounds(10);
    const out = w.sent.filter((m) => m.kind === "mail_send") as { sendAt?: string }[];
    expect(out).toHaveLength(1);
    expect(Date.parse(out[0]!.sendAt ?? "")).toBeGreaterThan(Date.now() + 60_000);
    expect(w.sent.filter((m) => m.kind !== "mail_send" && m.kind !== "draft_save")).toEqual([]);
  });

  it("with the card open, Mod+Enter schedules the time it holds and nothing goes now; 2 takes tomorrow morning", async () => {
    const noon = new Date("2026-11-20T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: noon });
    setFormatWords({ locale: () => "en", zone: () => "UTC", translatorOf: () => null });
    onTestFinished(() => {
      vi.useRealTimers();
      setFormatWords(null);
    });
    const w = await mountWriting({ view: true });
    await typeLetter("lena@example.invalid", "For the morning.");
    await act(async () => {
      fireEvent.click(verb(W.later.verb));
    });
    const day = screen.getByLabelText<HTMLInputElement>(W.later.day).value;
    const time = screen.getByLabelText<HTMLInputElement>(W.later.time);
    const held = `${day}T${time.value}:00.000Z`;
    expect(sends(w)).toBe(0);
    await act(async () => {
      fireEvent.keyDown(time, { key: "Enter", ctrlKey: true });
    });
    await rounds(10);
    const first = w.sent.filter((m) => m.kind === "mail_send") as { sendAt?: string }[];
    expect(first).toHaveLength(1);
    expect(first[0]!.sendAt).toBe(held);
    expect(Date.parse(first[0]!.sendAt ?? "")).toBeGreaterThan(Date.now() + 60_000);

    // In the small hours, "tomorrow morning" means the coming morning on the same calendar day.
    const mornings = [
      [noon, "2026-11-21T09:00:00.000Z"],
      [new Date("2026-11-20T01:23:00.000Z"), "2026-11-20T09:00:00.000Z"],
    ] as const;
    for (const [now, sendAt] of mornings) {
      await unmountWritings();
      vi.setSystemTime(now);
      const again = await mountWriting({ view: true });
      await typeLetter("lena@example.invalid", "For the morning.");
      await act(async () => {
        fireEvent.click(verb(W.later.verb));
      });
      expect(sends(again)).toBe(0);
      await act(async () => {
        fireEvent.keyDown(screen.getByRole("button", { name: W.later.confirm }), { key: "2" });
      });
      await rounds(10);
      const out = again.sent.filter((m) => m.kind === "mail_send") as { sendAt?: string }[];
      expect(out).toHaveLength(1);
      expect(out[0]!.sendAt).toBe(sendAt);
      expect(Date.parse(sendAt)).toBeGreaterThan(Date.now());
    }
  });

  it("with the card open, Mod+Enter from the letter's text sends nothing now", async () => {
    const w = await mountWriting({ view: true });
    await typeLetter("lena@example.invalid", "For the morning.");
    await act(async () => {
      fireEvent.click(verb(W.later.verb));
    });
    const text = screen.getByRole("textbox", { name: W.text });
    await act(async () => {
      text.focus();
      fireEvent.keyDown(text, { key: "Enter", ctrlKey: true });
    });
    await rounds(10);
    expect(sends(w)).toBe(0);
  });

  it("a time under the floor is refused in words before the wire", async () => {
    const w = await mountWriting({ view: true });
    await typeLetter("lena@example.invalid", "Too late for this.");
    await act(async () => {
      fireEvent.click(verb(W.later.verb));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(W.later.day), { target: { value: "2020-01-01" } });
    });
    expect(document.body.textContent).toContain(W.later.past);
    const confirm = screen.getByRole("button", { name: W.later.confirm }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(confirm);
    });
    await rounds(6);
    expect(sends(w)).toBe(0);
  });
});

describe("from", () => {
  it("one address is said as words; with two, the one picked is the one the send goes from", async () => {
    await mountWriting({ view: true });
    expect(screen.queryByRole("button", { name: /choose another address/ })).toBeNull();
    expect(document.body.textContent).toContain("me@example.invalid");
    await unmountWritings();
    const w = await mountWriting({ view: true, secondMailbox: true });
    await typeLetter("lena@example.invalid", "From the other address.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /choose another address/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "me2@example.invalid" }));
    });
    await rounds(4);
    expect(w.now().compose.fromMailboxId).toBe("mb2");
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(10);
    const out = w.sent.find((m) => m.kind === "mail_send") as { mailboxId?: string };
    expect(out.mailboxId).toBe("mb2");
  });
});

describe("a send nobody can confirm", () => {
  it("survives a remount with Send locked and its two answers, and is no word of another account's letter", async () => {
    const row = letter("d-a", "Plans for Friday", "Shall we meet at noon?");
    const a = await mountWriting({ view: true, drafts: [row] });
    await act(async () => a.now().openDraft(row));
    await rounds(6);
    Object.assign(a.refuseSend, { on: true, unverified: true });
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(30);
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByRole("button", { name: W.held.sendAgain })).toBeTruthy();
    await a.unmount();

    const again = await mountWriting({ view: true, store: a.store });
    await rounds(10);
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByRole("button", { name: W.held.itWasSent })).toBeTruthy();
    expect(sends(again)).toBe(0);
    await again.unmount();

    /* Signed in as another account: its own mirror, the same browser. */
    const b = await mountWriting({ view: true, scope: "acc-2" });
    await rounds(10);
    expect(document.body.textContent).not.toContain("Plans for Friday");
    expect(document.body.textContent).not.toContain("Shall we meet at noon?");
    expect(richText().getText()).toBe("");
    expect(screen.queryByRole("button", { name: W.held.sendAgain })).toBeNull();
    expect(readComposeDraft("acc-2")?.body ?? "").toBe("");
    expect(readComposeDraft("acc-2")?.subject ?? "").toBe("");
    expect(sends(b)).toBe(0);
  });
});

/** A drafter: each purchase answers a draft of its own ("first draft", ...); `gate` holds the next answer. */
function drafter(fromText: "door" | "none" = "door") {
  const asked: { key: string; body: unknown }[] = [];
  const state = { gate: null as Promise<void> | null };
  let n = 0;
  const names = ["first draft", "second draft", "third draft"];
  const buy = async (): Promise<{ draftId: string }> => {
    n += 1;
    const mine = n;
    if (state.gate) await state.gate;
    return { draftId: `d-${mine}` };
  };
  const wire: DraftReplyWire = {
    configured: () => true,
    create: async (_id, key) => {
      asked.push({ key, body: "reply" });
      return buy();
    },
    read: async (draftId) => ({ body: names[Number(draftId.slice(2)) - 1] ?? "?", html: null }),
    fromText:
      fromText === "none"
        ? "none"
        : async (body, key) => {
            asked.push({ key, body });
            return buy();
          },
  };
  return { wire, asked, state };
}
const letterText = (): string => richText().getText();
const control = (label: string): HTMLButtonElement => screen.getByRole("button", { name: label }) as HTMLButtonElement;

describe("draft from your text, on a new letter", () => {
  it("stands quiet until words are written: a press with none says so and asks nothing", async () => {
    const d = drafter();
    await mountWriting({ view: true, draftWire: d.wire, metered: true });
    expect(document.body.textContent).not.toContain("15 credits");
    expect(control(W.draft.letterVerb).getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(control(W.draft.letterVerb));
    });
    await rounds(4);
    expect(document.body.textContent).toContain(W.draft.nothingYet);
    expect(d.asked).toEqual([]);
    await typeLetter("lena@example.invalid", "noon ok");
    expect(document.body.textContent).not.toContain(W.draft.nothingYet);
    expect(control(W.draft.fromText).getAttribute("aria-disabled")).toBeNull();
    expect(control(W.draft.fromText).title).toContain("15");
    expect(document.body.textContent).toContain("15 credits");
    expect(d.asked).toEqual([]);
  });

  it("one press drafts it from the words, the address and the subject, once however often pressed while it runs", async () => {
    const d = drafter();
    const w = await mountWriting({ view: true, draftWire: d.wire, metered: true });
    await typeLetter("lena@example.invalid", "noon ok");
    let release = (): void => undefined;
    d.state.gate = new Promise((r) => (release = r));
    await act(async () => {
      fireEvent.click(control(W.draft.fromText));
      fireEvent.click(control(W.draft.fromText));
    });
    await rounds(4);
    await act(async () => {
      fireEvent.click(control(W.draft.running));
    });
    await act(async () => release());
    await rounds(10);
    expect(d.asked.map((a) => a.body)).toEqual([{ text: "noon ok", mailboxId: "mb1", subject: "Friday" }]);
    expect(letterText()).toBe("first draft");
    /* The person's words one tab away; the send carries the text on screen, once. */
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: W.draft.yours }));
    });
    await rounds(4);
    expect(letterText()).toBe("noon ok");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: W.draft.draft }));
    });
    await rounds(4);
    expect(letterText()).toBe("first draft");
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await rounds(10);
    const sent = w.sent.filter((m) => m.kind === "mail_send") as unknown as { body: string }[];
    expect(sent.map((m) => m.body)).toEqual(["first draft"]);
  });

  it("Draft again is a new purchase under a new key, made of the person's words and never the model's", async () => {
    const d = drafter();
    await mountWriting({ view: true, draftWire: d.wire, metered: true });
    await typeLetter("lena@example.invalid", "noon ok");
    await act(async () => {
      fireEvent.click(control(W.draft.fromText));
    });
    await rounds(10);
    await act(async () => {
      fireEvent.click(control(W.draft.again));
    });
    await rounds(10);
    expect(d.asked.map((a) => a.body)).toEqual([
      { text: "noon ok", mailboxId: "mb1", subject: "Friday" },
      { text: "noon ok", mailboxId: "mb1", subject: "Friday" },
    ]);
    expect(new Set(d.asked.map((a) => a.key)).size).toBe(2);
    expect(letterText()).toBe("second draft");
  });

  it("where the host has no door for it, or hands no draft wire, no draft control is drawn and nothing is asked", async () => {
    const d = drafter("none");
    const w = await mountWriting({ view: true, draftWire: d.wire, metered: true });
    await typeLetter("lena@example.invalid", "noon ok");
    expect(screen.queryByRole("button", { name: W.draft.fromText })).toBeNull();
    expect(screen.queryByRole("button", { name: W.draft.letterVerb })).toBeNull();
    await w.unmount();
    await mountWriting({ view: true });
    await typeLetter("lena@example.invalid", "noon ok");
    expect(screen.queryByRole("button", { name: W.draft.fromText })).toBeNull();
    expect(d.asked).toEqual([]);
  });

  it("a forward opened from Drafts offers no draft: with words written no control is drawn and nothing is asked", async () => {
    const d = drafter();
    const forward = Object.assign(letter("d-fwd", "Fwd: Subject m1", ""), { forwardOfMessageId: "m1" });
    const w = await mountWriting({ view: true, draftWire: d.wire, metered: true, messages: [message("m1")], drafts: [forward] });
    await act(async () => w.now().openDraft(forward));
    await rounds(8);
    await act(async () => {
      writeText("Have a look at this.");
    });
    await rounds(2);
    const offered =
      screen.queryByRole("button", { name: W.draft.fromText }) ?? screen.queryByRole("button", { name: W.draft.letterVerb });
    if (offered !== null) {
      await act(async () => {
        fireEvent.click(offered);
      });
      await rounds(6);
    }
    expect({ forward: w.now().compose.forwardOf, offered: offered !== null, asked: d.asked }).toEqual({
      forward: "m1",
      offered: false,
      asked: [],
    });
  });

  it("a discarded letter lets its own text go; its Undo puts it back one tab away", async () => {
    const d = drafter();
    const w = await mountWriting({ view: true, draftWire: d.wire, metered: true });
    await typeLetter("lena@example.invalid", "noon ok");
    await act(async () => {
      fireEvent.click(control(W.draft.fromText));
    });
    await rounds(10);
    await act(async () => {
      fireEvent.click(within(screen.getByRole("toolbar", { name: W.verbs })).getByRole("button", { name: W.discard }));
    });
    await rounds(10);
    const said = w.reports.find((r) => r.message === en.compose.toastDiscard);
    await act(async () => said!.options!.onAction!());
    await rounds(10);
    expect(letterText()).toBe("first draft");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: W.draft.yours }));
    });
    await rounds(4);
    expect(letterText()).toBe("noon ok");
  });

  it("a draft still out when another draft is opened into the composer leaves that draft's words as they are", async () => {
    const d = drafter();
    const other = letter("d-b", "Budget", "B's own words stay.");
    const w = await mountWriting({ view: true, draftWire: d.wire, metered: true, drafts: [other] });
    await typeLetter("lena@example.invalid", "noon ok");
    let release = (): void => undefined;
    d.state.gate = new Promise((r) => (release = r));
    await act(async () => {
      fireEvent.click(control(W.draft.fromText));
    });
    await rounds(4);
    await act(async () => w.now().openDraft(other));
    await rounds(20);
    const opened = { text: letterText(), subject: w.now().compose.subject };
    await act(async () => release());
    await rounds(12);
    expect({
      opened,
      asked: d.asked.map((a) => a.body),
      after: letterText(),
      buffer: readComposeDraft("acc-1")?.body ?? null,
      tabs: screen.queryByRole("button", { name: W.draft.yours }) !== null,
    }).toEqual({
      opened: { text: "B's own words stay.", subject: "Budget" },
      asked: [{ text: "noon ok", mailboxId: "mb1", subject: "Friday" }],
      after: "B's own words stay.",
      buffer: "B's own words stay.",
      tabs: false,
    });
  });

  it("a draft that landed over one letter offers no tabs over another letter opened into the composer", async () => {
    const d = drafter();
    const other = letter("d-b", "Budget", "B's own words stay.");
    const w = await mountWriting({ view: true, draftWire: d.wire, metered: true, drafts: [other] });
    await typeLetter("lena@example.invalid", "noon ok");
    await act(async () => {
      fireEvent.click(control(W.draft.fromText));
    });
    await rounds(10);
    const landed = letterText();
    await act(async () => w.now().openDraft(other));
    await rounds(20);
    const opened = letterText();
    const tabs = screen.queryByRole("button", { name: W.draft.yours }) !== null;
    if (tabs) {
      await act(async () => {
        fireEvent.click(control(W.draft.yours));
      });
      await rounds(4);
    }
    expect({ landed, opened, tabs, after: letterText() }).toEqual({
      landed: "first draft",
      opened: "B's own words stay.",
      tabs: false,
      after: "B's own words stay.",
    });
  });

  it("a letter discarded while its draft is out gets nothing written back; with Undo before the answer the draft lands in it", async () => {
    const discard = async (d: ReturnType<typeof drafter>): Promise<() => void> => {
      await typeLetter("lena@example.invalid", "noon ok");
      let release = (): void => undefined;
      d.state.gate = new Promise((r) => (release = r));
      await act(async () => {
        fireEvent.click(control(W.draft.fromText));
      });
      await act(async () => {
        fireEvent.click(within(screen.getByRole("toolbar", { name: W.verbs })).getByRole("button", { name: W.discard }));
      });
      await rounds(10);
      return release;
    };
    /* Discarded, and the answer comes: no letter and no buffer take it; the next letter says where it is. */
    const first = drafter();
    await mountWriting({ view: true, draftWire: first.wire, metered: true });
    const answer = await discard(first);
    await act(async () => answer());
    await rounds(12);
    const discarded = {
      text: letterText(),
      buffer: readComposeDraft("acc-1")?.body ?? "",
      tabs: screen.queryByRole("button", { name: W.draft.yours }) !== null,
      said: document.body.textContent?.includes(en.draftReply.letterLeft) === true,
    };
    await unmountWritings();
    resetComposerForTest();
    window.localStorage.clear();
    /* Discarded, then its Undo before the answer: the draft lands in the letter put back, its words one tab away. */
    const second = drafter();
    const back = await mountWriting({ view: true, draftWire: second.wire, metered: true });
    const later = await discard(second);
    const said = back.reports.find((r) => r.message === en.compose.toastDiscard);
    await act(async () => said!.options!.onAction!());
    await rounds(10);
    const undone = letterText();
    await act(async () => later());
    await rounds(12);
    const landed = letterText();
    const yours = screen.queryByRole("button", { name: W.draft.yours }) !== null;
    if (yours) {
      await act(async () => {
        fireEvent.click(control(W.draft.yours));
      });
      await rounds(4);
    }
    expect({ discarded, undone, landed, yours, own: letterText() }).toEqual({
      discarded: { text: "", buffer: "", tabs: false, said: true },
      undone: "noon ok",
      landed: "first draft",
      yours: true,
      own: "noon ok",
    });
  });

  it("the letter's own row opened again from Drafts is the same letter: its draft stays, Your text one tab away", async () => {
    const d = drafter();
    const own = letter("d-a", "Friday", "noon ok");
    const w = await mountWriting({ view: true, draftWire: d.wire, metered: true, drafts: [own] });
    await act(async () => w.now().openDraft(own));
    await rounds(8);
    await act(async () => {
      fireEvent.click(control(W.draft.fromText));
    });
    await rounds(10);
    /* The pause writes the drafted words into the letter's own row; the list hands that row. */
    await act(async () => new Promise((r) => setTimeout(r, 2_300)));
    await rounds(8);
    const row = w.engine.read().get<typeof own>("draft", "d-a");
    await act(async () => w.now().openDraft(row!));
    await rounds(20);
    const shown = letterText();
    const yours = screen.queryByRole("button", { name: W.draft.yours }) !== null;
    if (yours) {
      await act(async () => {
        fireEvent.click(control(W.draft.yours));
      });
      await rounds(4);
    }
    expect({ row: row?.body, shown, yours, own: letterText() }).toEqual({
      row: "first draft",
      shown: "first draft",
      yours: true,
      own: "noon ok",
    });
  });
});

