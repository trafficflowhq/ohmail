/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, screen, within } from "@testing-library/react";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { SENDING_LONG_MS, type SendState } from "@ohmail/app-logic/writing/mail-send";
import { resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import { act, message, stubDom } from "./_draft-shell.js";
import { letter } from "./_handoff-steps.js";
import { GROUND_CATALOGUE } from "./_write-1-send-text.js";
import { mountWriting, rounds, unmountWritings, type WritingWorld } from "./_write-1-writing.js";

/**
 * THE TWO `queued` STATES, AND THE LONG-SEND LINE — the states the ceiling added, said correctly.
 *
 * A send can now be `queued` for two reasons that look identical on screen and are not the same
 * fact at all:
 *
 *   the SERVER accepted it   the reservation is committed under this key and the submission is
 *                            still being handed to the mail server (the send route's own 202,
 *                            past its attempt ceiling). "Accepted" is true; the surface may close.
 *   the TRANSPORT refused    the request may never have arrived. The only honest line is that it
 *                            has not gone yet, and the surface stays open.
 *
 * Saying "Accepted. ohmail sends it on its next pass." about a request nobody received is a false
 * claim about a person's mail, and it is one careless `else` away — so it is asserted here in both
 * directions and in both locales, because a translation is where a distinction quietly collapses.
 *
 * The third case is the long-send line: a send still running at four seconds stops saying
 * "Sending your message" and says the product still knows about it. Measured against the thing it
 * describes — a healthy send settles well inside a second, and the slowest shipped provider takes
 * a few — so four seconds is past every ordinary send and short of the point where somebody
 * decides the button is broken.
 *
 * OVER WRITE (the older tests' sorting, share write-1): today's `SendStatus` and `ComposeView` leave with the
 * switch. The send line is Write's (`packages/app/src/write/status/Status.tsx`), read over Write's reply in the
 * reader's slot, the send machine's state handed where the composition reads it (`replySend`,
 * `_write-1-writing.tsx`). Its words are Write's catalogue (`write.status.*`): the same sentences as today's
 * `reply.status*`, but for the opening line, which follows Write's words ("Sending your message"; today's reply
 * said "Sending your reply"). Send later is Write's card (`write/verbs/Later.tsx`) over Write's new letter: today's
 * `fields` prop is the composition's own fields (`onComposeFields`), the door's answer about files the engine's
 * `scheduleFilesAnnounced`, today's `onSendLater` the send the pick puts on the wire.
 */

const PARENT = message("m1", { subject: "Werkstatt-Besuch?" });

/** Write's reply to PARENT in the reader's slot, the send machine's state for it `send`. */
async function replyWith(
  send: SendState,
  locale: "en" | "de" = "en",
  flush: () => Promise<void> = () => rounds(2),
): Promise<WritingWorld> {
  const w = await mountWriting({ messages: [PARENT], hash: "#/ohbox", sheet: ["m1"], replySend: send, locale });
  await act(async () => { w.now().openReply("m1"); });
  await act(async () => { w.now().onReplyBody({ text: "Donnerstag passt.", html: "" }); });
  await flush();
  return w;
}
/** The reply's send line, as a person reads it. */
const statusOf = (w: WritingWorld): string => w.el.querySelector<HTMLElement>("[role=status]")?.textContent ?? "";
/** What the send line says for `send` in `locale` (today's pure component; now Write's reply as it stands). */
async function render(send: SendState, locale: "en" | "de"): Promise<string> {
  return statusOf(await replyWith(send, locale));
}

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  await unmountWritings();
  resetComposerForTest();
});

describe("the server's accepted-pending send is not the transport's queued one", () => {
  it("accepted reads as a send still going, never as one that may not have arrived — en", async () => {
    // NOT `statusAccepted`: that string says "ohmail sends it on its next pass" and no pass
    // claims an interactive row (`claimDue` needs a `send_key` a manual send never has). What is
    // true is that the server holds the reservation and the submission is still in flight, which
    // is the same condition a long send is in — so it says that.
    const text = await render({ phase: "queued", accepted: true }, "en");
    expect(text).toBe(en.write.status.sendingLong); // today's en.reply.statusSendingLong, the same sentence
    expect(text, "the surface claimed a pass that will never look at this row")
      .not.toContain("next pass");
  });

  it("accepted reads as a send still going, never as one that may not have arrived — de", async () => {
    const text = await render({ phase: "queued", accepted: true }, "de");
    expect(text).toBe(de.write.status.sendingLong); // today's de.reply.statusSendingLong, the same sentence
    expect(text).not.toContain("Durchlauf");
  });

  it("a queued send with NO accepted flag never claims acceptance — en", async () => {
    const text = await render({ phase: "queued" }, "en");
    expect(text).toBe(en.write.status.queued); // today's en.reply.statusQueued, the same sentence
    expect(
      text,
      "a request that may never have arrived was reported as still on its way",
    ).not.toBe(en.write.status.sendingLong);
  });

  it("a queued send with NO accepted flag never claims acceptance — de", async () => {
    const text = await render({ phase: "queued" }, "de");
    expect(text).toBe(de.write.status.queued);
    expect(text).not.toBe(de.write.status.sendingLong);
  });
});

describe("a send that is still going says so", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  /* Under the case's own clock: the mount's rounds move it a millisecond each, and are counted from `since`. */
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  };

  it("swaps to the long-send line at the threshold, and not before", async () => {
    const since = Date.now();
    const w = await replyWith({ phase: "sending", since }, "en", tick);

    expect(statusOf(w), "the opening line is the one a normal send shows")
      .toBe(en.write.status.sending); // Write's words: "Sending your message" (today's reply: "Sending your reply")

    await act(async () => { await vi.advanceTimersByTimeAsync(since + SENDING_LONG_MS - 1 - Date.now()); });
    expect(statusOf(w), "the line changed before the threshold").toBe(en.write.status.sending);

    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(statusOf(w), "a send past the threshold still says nothing new")
      .toBe(en.write.status.sendingLong);
  });

  it("a send ALREADY past the threshold when it renders says so immediately", async () => {
    const w = await replyWith({ phase: "sending", since: Date.now() - SENDING_LONG_MS - 1 }, "en", tick);
    // The surface can be re-rendered mid-send (a re-mount, a parent update). Deriving from the
    // phase's own stamp rather than from this component's lifetime is what makes that case right.
    expect(statusOf(w)).toBe(en.write.status.sendingLong);
  });
});

/* ---------------------------------------------------------------- the new letter, as a person writes it */

const verbs = (): HTMLElement => screen.getByRole("toolbar", { name: en.write.verbs });
const verb = (name: string): HTMLButtonElement => within(verbs()).getByRole("button", { name }) as HTMLButtonElement;

/** A person writes the letter: To, the subject, the words (the To line offers people: a combobox). */
async function typeLetter(to: string, subject: string, body: string): Promise<void> {
  const typed = screen.getByRole("combobox", { name: en.write.to });
  await act(async () => { fireEvent.change(typed, { target: { value: to } }); });
  await act(async () => { fireEvent.keyDown(typed, { key: "Enter" }); });
  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: en.write.subject }), { target: { value: subject } });
  });
  const box = screen.getByRole("textbox", { name: en.write.text }) as HTMLElement & {
    editor?: { chain(): { selectAll(): { insertContent(w: string): { run(): boolean } } } };
  };
  await act(async () => { box.editor!.chain().selectAll().insertContent(body).run(); });
  await rounds(2);
}

describe("the button's word and its state attribute come from one derivation", () => {
  it("a send-later confirm says Scheduled on the compose form and Sent on a reply", async () => {
    // Nothing was sent; an appointment was made. "Sent" over it is the false claim the phase
    // machine exists to prevent — and the reply scope has no `scheduled` key to render at all,
    // so asking for one there would put a key's own name in front of a reader.
    // OVER WRITE: Write's Send keeps its one word through every phase and the send says itself in words: on the
    // new letter, the schedule's report; on a reply, its send line.
    const w = await mountWriting({ view: true });
    await typeLetter("ada@fake.test", "later", "words");
    await act(async () => { fireEvent.click(verb(en.write.later.verb)); });
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /^Tomorrow morning/ })); });
    await rounds(10);
    const said = w.reports.map((r) => r.message);
    const scheduled = en.compose.toastScheduled.split("{when}")[0]!;
    expect(said.some((m) => m.startsWith(scheduled)), `the schedule was not said: ${JSON.stringify(said)}`).toBe(true);
    expect(said, "a schedule was reported as a send").not.toContain(GROUND_CATALOGUE("compose.toastSent"));
    expect(w.el.textContent ?? "", "the letter said Sent over an appointment").not.toMatch(/\bSent\b/);
    await unmountWritings();

    const r = await replyWith({ phase: "sent", scheduled: true });
    const reply = r.el.textContent ?? "";
    expect(reply, "the reply rendered a key's own name").not.toMatch(/\b(?:write|reply|compose|status)\.[a-zA-Z]+/);
    expect(reply, "the reply said Scheduled").not.toMatch(/\bScheduled\b/);
    expect(within(r.el).queryByRole("button", { name: /Scheduled/ }), "the reply said Scheduled").toBeNull();
  });

  it("every key the verb can name exists in BOTH locales, in both scopes it is used in", () => {
    // The compose form is the only scope that can reach `scheduled`; the guard says so rather
    // than asserting a key the reply catalogue deliberately does not carry.
    // OVER WRITE: the verbs' words are read where Write names them: the new letter's verbs (`verbs/Verbs.tsx`) and the
    // reply's (`Reply.tsx`), each a key of Write's own namespace (`t`) or the reply's (`tr`).
    const source = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
    const letterKeys = [...source("packages/app/src/write/verbs/Verbs.tsx").matchAll(/\bt\("([^"]+)"\)/g)].map((m) => ["write", m[1]!] as const);
    const replyKeys = [...source("packages/app/src/write/Reply.tsx").matchAll(/const \w+Word = (t|tr)\("([^"]+)"\)/g)]
      .map((m) => [m[1] === "t" ? "write" : "reply", m[2]!] as const);
    expect(letterKeys.length, "the census read no word of the letter's verbs").toBeGreaterThanOrEqual(3);
    expect(replyKeys.length, "the census read no word of the reply's verbs").toBeGreaterThanOrEqual(3);
    for (const [messages, name] of [[en, "en"], [de, "de"]] as const) {
      for (const [scope, key] of [...letterKeys, ...replyKeys]) {
        // Read as `unknown` and narrowed by the assertion, NOT cast to a two-level record: the
        // catalogue nests deeper than that in other scopes (`screener.empty.waiting.title`), so
        // the direct cast does not overlap and `apps/webapp` — one of the four packages that
        // typecheck their TESTS — fails the whole gate on it.
        const catalogue = messages as unknown as Record<string, unknown>;
        const word = key.split(".").reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], catalogue[scope]);
        expect(
          word,
          `${name}.${scope}.${key} is missing — the button would render the key's own name`,
        ).toBeTypeOf("string");
      }
    }
  });
});

/**
 * SEND LATER WITH FILES (mail 0179, 0180) — the composer offers the times only where the door keeps
 * the files (`/hello`: the desktop's own engine, or a server naming its horizon), and on a server only
 * inside that horizon. Elsewhere the panel says why in visible words, in place of the times, before any pick.
 */
describe("Send later on a letter with files says what it can do before the pick", () => {
  const FILE = { filename: "photo.png", contentType: "image/png", contentBase64: "aGk=" };

  const DESKTOP = { kept: true, days: null };
  type Kept = { kept: boolean; days: number | null } | null;
  /** Write's new letter, written, the door answering `kept` about files; `files`: the letter carries one. */
  async function compose(o: { kept: Kept; files: boolean; forwardOf?: string }): Promise<{
    w: WritingWorld;
    setFiles: (files: boolean) => Promise<void>;
  }> {
    const w = await mountWriting({ view: true, messages: o.forwardOf ? [message(o.forwardOf)] : [] });
    Object.assign(w.engine, { scheduleFilesAnnounced: async () => o.kept });
    await typeLetter("ada@fake.test", "later", "words");
    const setFiles = async (files: boolean): Promise<void> => {
      await act(async () => {
        const c = w.now();
        c.onComposeFields({
          ...c.compose,
          attachments: files ? [FILE] : [],
          ...(o.forwardOf ? { forwardOf: o.forwardOf } : {}),
        });
      });
      await rounds(4);
    };
    await setFiles(o.files);
    return { w, setFiles };
  }
  const toggle = (): HTMLButtonElement => verb(en.write.later.verb);
  /** The card, standing open. */
  const card = (): HTMLElement | null =>
    screen.queryByRole("dialog", { name: en.write.later.title }) ?? screen.queryByRole("menu", { name: en.write.later.title });
  /** Every press the card offers: its times and its way back. */
  const presets = (): string[] =>
    card() === null ? [] : within(card()!).queryAllByRole("menuitem").map((b) => (b.textContent ?? "").trim());
  const panelText = (): string => card()?.textContent ?? "";
  /** The card's field for a time of one's own (today's one `#compose-send-at`; Write's day and time). */
  const dayField = (): HTMLInputElement | null =>
    card() === null ? null : (within(card()!).queryByLabelText(en.write.later.day) as HTMLInputElement | null);
  const timeField = (): HTMLInputElement | null =>
    card() === null ? null : (within(card()!).queryByLabelText(en.write.later.time) as HTMLInputElement | null);
  const scheduled = (w: WritingWorld): { sendAt?: string; attachments?: { filename: string }[] }[] =>
    w.sent.filter((m) => m.kind === "mail_send") as never;

  it("where the door keeps files, a pick schedules the letter with them", async () => {
    const { w } = await compose({ kept: DESKTOP, files: true });
    expect(toggle().disabled).toBe(false);
    await act(async () => { toggle().click(); });
    const tomorrow = presets().find((p) => p.startsWith("Tomorrow"));
    expect(tomorrow, "no times were offered").toBeDefined();
    expect(panelText()).toContain(en.write.later.thisComputer);
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: tomorrow })); });
    await rounds(10);
    expect(scheduled(w)).toHaveLength(1);
  });

  for (const kept of [{ kept: false, days: null }, null] as const) {
    it(`where the door ${kept !== null ? "says it keeps none" : "cannot say"}, the panel says so in words and offers no time`, async () => {
      const { w } = await compose({ kept, files: true });
      expect(toggle().disabled, "the reason must be reachable, not hidden in a title").toBe(false);
      await act(async () => { toggle().click(); });
      expect(panelText()).toContain(kept !== null ? en.write.later.filesNotHere : en.write.later.unavailable);
      expect(presets()).toEqual([en.write.later.back]); // today's one Close: the card's way back
      expect(dayField()).toBeNull();
      expect(timeField()).toBeNull();
      await rounds(4);
      expect(scheduled(w)).toEqual([]);
    });
  }

  it("a file attached while the panel is open swaps the times for the sentence", async () => {
    const view = await compose({ kept: { kept: false, days: null }, files: false });
    await act(async () => { toggle().click(); });
    expect(presets().some((p) => p.startsWith("Tomorrow"))).toBe(true);
    await view.setFiles(true);
    expect(panelText()).toContain(en.write.later.filesNotHere);
    expect(presets()).toEqual([en.write.later.back]);
  });

  it("a pick while a file is still being read waits for it, then carries both files", async () => {
    // The file is put on as a person does it, through the clip; its read is held where Write reads it.
    const { w } = await compose({ kept: { kept: true, days: null }, files: true });
    await act(async () => { toggle().click(); });
    expect(presets().some((p) => p.startsWith("Tomorrow"))).toBe(true);

    let held: FileReader | null = null;
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) { held = this; });
    const input = w.el.querySelector<HTMLInputElement>('input[type="file"]')!;
    const pdf = new File([new Uint8Array([37, 80, 68, 70])], "invoice.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { configurable: true, get: () => [pdf] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await rounds(4);
    expect(held, "the read is in flight").not.toBeNull();

    expect(panelText()).toContain("Still attaching invoice.pdf.");
    expect(presets().some((p) => p.startsWith("Tomorrow")), "no time is offered over a file still being read").toBe(false);
    expect(dayField()).toBeNull();
    /* The keys go where the card takes them: on the card. */
    const key = async (k: string, mods: KeyboardEventInit = {}): Promise<void> => {
      const at = card() ?? document.body;
      await act(async () => { at.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods })); });
    };
    await key("2");
    await key("Enter", { ctrlKey: true });
    await key("Enter", { metaKey: true });
    await rounds(4);
    expect(scheduled(w), "nothing scheduled while the file is still being read").toEqual([]);

    Object.defineProperty(held!, "result", { configurable: true, get: () => "data:application/pdf;base64,JVBERg==" });
    await act(async () => { held!.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>); });
    await rounds(4);
    read.mockRestore();
    const tomorrow = presets().find((p) => p.startsWith("Tomorrow"));
    expect(tomorrow, "the times come back once the read commits").toBeDefined();
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: tomorrow })); });
    await rounds(10);
    expect(scheduled(w).map((m) => (m.attachments ?? []).map((a) => a.filename))).toEqual([["photo.png", "invoice.pdf"]]);
  });

  it("a row whose schedule ended unsent says its files were not kept, until they are attached again", async () => {
    // The row as the door leaves it: a schedule that ended unsent, back to a draft, its two files not kept.
    const row = { ...letter("d-later", "later", "words", { name: "Ada", address: "ada@fake.test" }), sendFiles: 2 };
    const w = await mountWriting({ view: true, drafts: [row as never] });
    await act(async () => w.now().openDraft(row as never));
    await rounds(4);
    const said = "This message was scheduled with 2 files that were not kept. Attach them again before you send.";
    expect(w.el.textContent).toContain(said);
    await act(async () => {
      const c = w.now();
      c.onComposeFields({ ...c.compose, attachments: [FILE] });
    });
    await rounds(4);
    expect(w.el.textContent).not.toContain(said);
  });

  describe("on a server that keeps files only so far ahead", () => {
    // The picker shows local dates and times. Tomorrow at 09:00 is inside the server's 24-hour limit.
    const openedAt = new Date(2026, 10, 4, 10);
    const cutoff = new Date(openedAt.getTime() + 24 * 60 * 60 * 1000);
    beforeEach(() => { vi.useFakeTimers({ now: openedAt, toFake: ["Date"] }); });
    afterEach(() => { vi.useRealTimers(); });

    it("offers no time past the horizon, caps the field there, and says how far", async () => {
      await compose({ kept: { kept: true, days: 1 }, files: true });
      await act(async () => { toggle().click(); });
      expect(presets().some((p) => p.startsWith("Tomorrow"))).toBe(true);
      expect(presets().some((p) => p.startsWith("Monday")), "a preset past the horizon was offered").toBe(false);
      expect(panelText()).toContain("A message with files can be scheduled up to 1 day ahead.");
      expect(panelText()).not.toContain(en.write.later.thisComputer);
    });

    it("caps the field at the horizon", async () => {
      // Split out of "offers no time past the horizon, caps the field there, and says how far", word for word:
      // The date picker must enforce the latest allowed send date.
      await compose({ kept: { kept: true, days: 1 }, files: true });
      await act(async () => { toggle().click(); });
      const lastDay = dayField()?.max;
      expect(lastDay).toBe("2026-11-05");
      const [year, month, day] = String(lastDay).split("-").map(Number);
      const start = new Date(year, month - 1, day);
      const following = new Date(start);
      following.setDate(following.getDate() + 1);
      expect(start.getTime()).toBeLessThanOrEqual(cutoff.getTime());
      expect(following.getTime()).toBeGreaterThan(cutoff.getTime());
    });

    it("a time typed past it is refused in words before the pick", async () => {
      const { w } = await compose({ kept: { kept: true, days: 1 }, files: true });
      await act(async () => { toggle().click(); });
      const confirm = () => within(card()!).getByRole("button", { name: en.write.later.confirm }) as HTMLButtonElement;
      for (const [day, time] of [["2026-11-05", "10:01"], ["2026-11-05", "12:00"], ["2026-11-07", "12:00"]] as const) {
        await act(async () => { fireEvent.change(dayField()!, { target: { value: day } }); });
        await act(async () => { fireEvent.change(timeField()!, { target: { value: time } }); });
        expect(panelText()).toContain("A message with files can be scheduled at most 1 day ahead. Pick a closer time.");
        expect(confirm().disabled).toBe(true);
        await rounds(4);
        expect(scheduled(w)).toEqual([]);
      }

      await act(async () => { fireEvent.change(dayField()!, { target: { value: "2026-11-05" } }); });
      await act(async () => { fireEvent.change(timeField()!, { target: { value: "10:00" } }); });
      expect(confirm().disabled).toBe(false);
      await act(async () => { confirm().click(); });
      await rounds(8);
      expect(scheduled(w)).toMatchObject([{ sendAt: cutoff.toISOString(), attachments: [{ filename: "photo.png" }] }]);
    });

    it("a file attached with the panel open takes the times past the horizon away", async () => {
      const view = await compose({ kept: { kept: true, days: 1 }, files: false });
      await act(async () => { toggle().click(); });
      expect(presets().some((p) => p.startsWith("Monday")), "a letter without files has no horizon").toBe(true);
      expect(dayField()?.max).toBe("");
      await view.setFiles(true);
      expect(presets().some((p) => p.startsWith("Monday"))).toBe(false);
      expect(dayField()?.max).toBe("2026-11-05");
      expect(panelText()).toContain("up to 1 day ahead");
    });
  });

  it("a forward is never scheduled, and its own sentence says so", async () => {
    // OVER WRITE: Write's Send later opens its card for a forward too, and the card says why in words in place of the
    // times (today's verb was disabled with the sentence as its title).
    const { w } = await compose({ kept: DESKTOP, files: false, forwardOf: "m-1" });
    await act(async () => { toggle().click(); });
    expect(panelText()).toContain(en.write.later.noForwards);
    expect(presets()).toEqual([en.write.later.back]);
    expect(dayField()).toBeNull();
    await rounds(4);
    expect(scheduled(w)).toEqual([]);
  });
});
