/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import { editorOf, typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import { act, message, mountShell as mountDraftShell, press, stubDom, unmountAll, type DraftShell } from "./_draft-shell.js";
import writeEn from "../../../packages/app/messages/write.en.json" with { type: "json" };
import { ohboxRow, openLetter, openSubject as subjectShown, readingColumn, reportSays, replyEditor } from "./ohbox/_finders.js";

/**
 * ═══ CANCELLING A REPLY PUTS YOU BACK IN THE MESSAGE, WITH NOTHING LEFT BEHIND ═══════════
 *
 * The reply editor has always had a Cancel; what was never guarded is what it LEAVES. Two
 * things can go wrong and neither is visible from the editor's own markup:
 *
 *  1. THE DOCK. At split width the editor is wrapped in `.reply-dock` — a sticky positioner
 *     pinned to the bottom of the reading column (`reader.css`; the panel inside it carries
 *     the skin and its own viewport bound — `reply-panel.test.tsx`). The
 *     wrapper is `ReadingPane`'s, not the editor's, so a cancel that unmounted the editor while
 *     the wrapper survived would leave a padded empty band stuck across the foot of
 *     every message the reader opened afterwards. `ReadingPane` renders no wrapper when there
 *     is no reply — that is the invariant, and this file is what watches it.
 *
 *  2. THE TEXT. Cancel CLOSES; it does not discard. The per-message scratch buffer
 *     (`mail-send.ts`, `localStorage`) survives, so reopening the editor on that message brings
 *     back what was written. That is deliberate and it is what makes Cancel safe to press —
 *     Escape does exactly the same thing (`AppShell`'s escape cascade closes the innermost open
 *     layer), and neither key destroys a half-written answer. The compose surface's Cancel is a
 *     different verb for a different reason: it owns a row on the ACCOUNT, so leaving it alone
 *     would strand a draft (`compose-cancel.test.tsx`). Asserted here so that difference is a
 *     decision on the record rather than an accident nobody notices when one of them changes.
 *
 *  3. THE SEND. Cancel is the word on the button, and a QUEUED send is an intent standing on the
 *     outbox that the next reconnect delivers — so closing this dock over one used to leave a
 *     reply somebody had cancelled to go anyway, once, which is why it read as ordinary. The
 *     compose surface's Cancel has withdrawn its send since the composer got one; this one had
 *     not. It is the SAME act, so it is the same withdrawal — and it still does not touch the
 *     scratch, which is what keeps the two rules from becoming one.
 *
 * Driven through the whole shell in demo mode, for the reason `inline-reply.test.ts` gives: the
 * open, the close and the ownership of Escape all live in `AppShell`, and a `MessagePane`
 * mounted alone could not see any of it.
 *
 * RE-POINTED (share reader-1, the switch's older tests): the whole shell is the new one, through its test door
 * (`_draft-shell.ts`'s `mountShell`: the web's `MailShell`, the frame over the mail ground, the seated Ohbox, the
 * reader and `write`'s reply, over an engine whose wire this file can take offline). The letter is opened at the
 * Ohbox (History, where today's demo opened one, is not mounted yet; the cases are the reply's, not History's). The
 * reply is the one more sheet `write` draws after the conversation (the kit's composer, a section named "Reply to
 * …"), and THE STUDIO's REPLY HAS NO CANCEL BUTTON: its verbs are Send and Discard (which throws the words away, with
 * an Undo), and backing out of it is Escape from inside it (`onLeaveKey`: the same `closeReply` today's Cancel ran,
 * which withdraws a queued send and keeps the words). So every "Cancel" below is that Escape, pressed where the
 * keyboard is, as a person's is; each expectation as it stood. A park is said by the frame's report. The subject is
 * one line of the reply's head (no button opens it); the case of Escape in it handing the keyboard to the text is
 * `write`'s owed key (write HANDOVER, NOT built 3) and stands in a case of its own.
 */

/** `write`'s own catalogue: the reply's queued line is read by its key. */
const WRITE_EN = writeEn as unknown as { write: { status: { queued: string } } };
let shell: DraftShell | null = null;
/** The window, as the test door stubs it; `mobile` is a narrow one. */
function setViewport(mobile: boolean): void {
  stubDom({ narrow: mobile });
}

/** The whole client over one letter, with that letter open in the reading column. */
async function mountShell(): Promise<void> {
  shell = await mountDraftShell("#/ohbox", [message("m1")]);
  await waitFor(() => ohboxRow(document, "m1") !== null, "the Ohbox never listed its letter");
  await press(ohboxRow(document, "m1"), "the letter's row");
  await waitFor(() => openSubject() !== "", "the Ohbox never opened a message");
}

/** Poll until `ready()`, draining React between attempts; bounded by real time, never a tick count. */
async function waitFor(ready: () => boolean, why: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(why);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

/** Open the reply editor and wait for it to be on screen. */
async function openReply(): Promise<void> {
  await key("r");
  await waitFor(() => replySurface() !== null, "`r` opened no reply editor");
  await settleEditor();
}

const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
    );
  });
};
/** A key pressed where focus is, as a person's keyboard delivers it. */
const keyAtFocus = async (k: string): Promise<void> => {
  const at = (document.activeElement ?? document.body) as HTMLElement;
  await act(async () => {
    at.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
};

/** The reply: the one more sheet after the conversation, `write`'s composer named "Reply to …"; null while closed. */
const reply = (): HTMLElement | null =>
  readingColumn(document)?.querySelector<HTMLElement>('section[aria-label^="Reply to"]') ?? null;

/**
 * The open reply editor's surface, or null when the editor is closed.
 *
 * Scoped to the OPEN LETTER's sheet (the reading column's region named Open message), the question the journey
 * asks: an editor that is not inside the message it answers is the defect that moved Reply out of Compose.
 */
const replySurface = (): HTMLElement | null => {
  const editor = replyEditor(document);
  return editor !== null && openLetter(document)?.contains(editor) === true ? editor : null;
};

/** ProseMirror mounts a tick after the commit (`immediatelyRender: false`). */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

/**
 * The reply editor's surface, once ProseMirror has attached its handle to it.
 *
 * POLLED rather than flushed a fixed number of times: the surface is in the DOM for at least one commit before
 * the handle exists. The surface — not the `Editor` — is what comes back, because that is what `typeInto` takes.
 */
async function replyEditorSurface(): Promise<HTMLElement> {
  const handled = (): boolean => !!(replySurface() as unknown as { editor?: Editor } | null)?.editor;
  await waitFor(handled, "the reply editor never mounted a ProseMirror handle");
  return replySurface()!;
}

/** The open letter's subject, as its head says it. */
const openSubject = (): string => subjectShown(document);

/**
 * THE REPLY's CANCEL: the studio's reply backs out by Escape from inside it (there is no Cancel button), the same
 * `closeReply` today's Cancel ran. Pressed where the keyboard is; the text takes it back first where focus is elsewhere.
 */
const cancelReply = async (): Promise<void> => {
  const surface = replySurface();
  expect(surface, "the reply editor is not open to back out of").not.toBeNull();
  if (!surface!.contains(document.activeElement)) await act(async () => { surface!.focus(); });
  await keyAtFocus("Escape");
  await settle();
};

beforeEach(() => {
  setViewport(false);
  // jsdom draws no animation: the kit's sheets and lines ask for one as a browser runs it.
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
});

afterEach(async () => {
  await unmountAll();
  shell = null;
  vi.restoreAllMocks();
});

describe("Cancel returns to the message and strands nothing", () => {
  /**
   * ══ THE CENTRAL GUARD ══════════════════════════════════════════════════════════════════
   *
   * Mutation: give `ReadingPane` an unconditional `<div className="reply-dock">{reply}</div>`.
   * Three of this file's four go red; the first to fire is the REST state, because an
   * unconditional wrapper is already wrong before anything is opened. Real failure text:
   *   AssertionError: a reply dock exists before a reply was opened: expected
   *   <div class="reply-dock" /> to be null
   * …followed by `Escape left the dock behind` and the source guard below.
   */
  it("closes the editor AND takes the dock with it", async () => {
    await mountShell();
    const subject = openSubject();
    expect(subject, "the Ohbox rendered no message").not.toBe("");
    expect(reply(), "a reply dock exists before a reply was opened").toBeNull();

    await openReply();
    expect(reply()?.contains(replySurface()), "the open editor is not in a dock").toBe(true);

    await cancelReply();

    expect(replySurface(), "Cancel left the editor open").toBeNull();
    expect(
      reply(),
      "the reply dock survived the cancel — an empty sticky strip is pinned across the foot of "
        + "the reading column",
    ).toBeNull();
    // …and it is a RETURN, not a navigation: the message is still the one being read.
    expect(openSubject(), "cancelling the reply took the message off the screen").toBe(subject);
    // The view is unchanged; the open message rides the hash by design (`message-url.test.tsx`).
    expect(window.location.hash, "cancelling the reply changed the route").toMatch(/^#\/ohbox(\/m\/|$)/);
    expect(window.location.hash.startsWith("#/write"), "cancelling the reply landed in Compose").toBe(false);
  });

  /**
   * CANCEL IS A CLOSE, NOT A DISCARD — and the reply text is the thing that proves which.
   *
   * Mutation: clear the scratch buffer in `closeReply`. Real failure text:
   *   AssertionError: cancelling the reply destroyed what was written — Cancel closes the
   *   editor, it does not throw the answer away: expected '' to contain 'half a sentence'
   */
  it("keeps what was written, so reopening the reply restores it", async () => {
    await mountShell();
    await openReply();
    const surface = await replyEditorSurface();
    await act(async () => { typeInto(surface, "half a sentence"); });
    await settle();
    expect(editorOf(await replyEditorSurface()).getText()).toBe("half a sentence");

    await cancelReply();
    expect(replySurface()).toBeNull();

    await openReply();
    expect(
      editorOf(await replyEditorSurface()).getText(),
      "cancelling the reply destroyed what was written — Cancel closes the editor, it does not "
        + "throw the answer away",
    ).toBe("half a sentence");
  });

  /**
   * CANCEL WITHDRAWS THE SEND — the third thing this button leaves.
   *
   * Mutation: drop the `mailSend.withdraw` call from `closeReply`. Real failure text:
   *   AssertionError: closing the dock left a queued reply standing on the outbox: expected
   *   [] to have a length of 1
   *
   * The double answers `queued` — the engine's word for a wire that refused retryably, which is
   * what leaves an intent under its key. The withdrawal's own VERDICT is what is asserted, and
   * it is the engine's answer about the engine's own queue: `withdrawn` means a row was found
   * and taken off it, where `gone` means there was nothing there. A spy that only counted calls
   * would pass over a withdrawal that withdrew nothing.
   */
  it("withdraws a queued send, and still leaves what was written", async () => {
    await mountShell();
    await openReply();
    const surface = await replyEditorSurface();
    await act(async () => { typeInto(surface, "a queued answer"); });
    await settle();

    /* THE SEND IS MADE TO QUEUE: the route refuses it retryably (the test door's `refuseSend`), which is exactly the
       state Cancel exists for — an intent under its key, which the next try delivers. The server is reachable, and
       answers a withdrawal for that key: "withdrawn" (the test door's `withdrawAnswer`). */
    const { OhmailEngine } = await import("@ohmail/client-engine");
    shell!.refuseSend.on = true;
    shell!.refuseSend.retryableFirst = 1000;
    shell!.withdrawAnswer.outcome = "withdrawn";
    const withdrawals: string[] = [];
    const realWithdraw = OhmailEngine.prototype.withdrawQueued;
    vi.spyOn(OhmailEngine.prototype, "withdrawQueued").mockImplementation(async function (
      this: InstanceType<typeof OhmailEngine>, key: string,
    ) {
      const outcome = await realWithdraw.call(this, key);
      withdrawals.push(outcome);
      return outcome;
    });
    // The reply's Send stands in the open letter's panel while the reply stands.
    const send = readingColumn(document)?.querySelector<HTMLButtonElement>('[role="toolbar"][aria-label="Actions"] button[aria-label="Send"]');
    expect(send, "the reply editor offers no Send").toBeTruthy();
    await act(async () => { send!.click(); });
    await waitFor(
      () => shell!.engine.waitingSends().length > 0 && (reply()?.textContent ?? "").includes(WRITE_EN.write.status.queued),
      "the send never reached the queued state this case is about",
    );

    await cancelReply();
    await waitFor(() => replySurface() === null, "closing the dock left the editor open");
    await waitFor(
      () => withdrawals.length > 0,
      "closing the dock left a queued reply standing on the outbox",
    );
    expect(
      withdrawals,
      "the dock asked for a withdrawal and the engine had nothing queued to withdraw",
    ).toEqual(["withdrawn"]);

    /* …and the text is still there, which is the other half of the rule: withdrawing the SEND is
       not discarding the ANSWER. */
    await openReply();
    expect(
      editorOf(await replyEditorSurface()).getText(),
      "withdrawing the queued send threw the written answer away with it",
    ).toBe("a queued answer");
  });

  /** Escape is the same act as Cancel here — one meaning for "back out of this editor". */
  it("Escape does what Cancel does, and also leaves the message open", async () => {
    await mountShell();
    const subject = openSubject();
    await openReply();

    // Escape where the keyboard is: in the reply's text, where `r` put it.
    await keyAtFocus("Escape");
    await settle();

    expect(replySurface(), "Escape left the editor open").toBeNull();
    expect(reply(), "Escape left the dock behind").toBeNull();
    expect(openSubject(), "Escape closed the message as well as the editor").toBe(subject);
  });
});

describe("an open reply keeps the keyboard", () => {
  /* jsdom does not derive `isContentEditable` from the attribute; a browser does, and the
     keymap's typing guard reads it. Defined here the way a browser answers it. */
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
      configurable: true,
      get(this: HTMLElement) { return this.closest('[contenteditable="true"]') !== null; },
    });
  });
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { isContentEditable?: boolean }).isContentEditable;
  });

  /** Open a reply and attach files to it; they live only in the open editor. */
  async function replyWithFile(names: readonly string[] = ["notes.txt"]): Promise<HTMLElement> {
    await mountShell();
    await openReply();
    const surface = await replyEditorSurface();
    const input = reply()?.querySelector<HTMLInputElement>('input[type="file"]') ?? null;
    expect(input, "the reply drew no attach control").not.toBeNull();
    const files = names.map((n) => new File([new Uint8Array(512)], n, { type: "text/plain" }));
    Object.defineProperty(input!, "files", { value: files, configurable: true });
    await act(async () => { input!.dispatchEvent(new Event("change", { bubbles: true })); });
    await waitFor(() => names.every((n) => (reply()?.textContent ?? "").includes(n)), "the picked files never showed");
    return surface;
  }

  /* The park's own answer, said by the frame's report — the rail's "Parked" pile carries the same word. */
  const parked = (): boolean => reportSays().includes("Parked");

  /** The reply's subject: one line of its head, always drawn (the studio's; today's opened it from a button). */
  const subjectField = (): HTMLInputElement | null => reply()?.querySelector<HTMLInputElement>('input[aria-label="Subject"]') ?? null;
  /** Focus the subject as a press does. */
  const intoSubject = async (): Promise<HTMLInputElement> => {
    const field = subjectField();
    expect(field, "the reply drew no subject").not.toBeNull();
    await act(async () => { field!.focus(); field!.click(); });
    expect(document.activeElement, "the subject field did not take focus").toBe(field);
    return field!;
  };

  /* Mutation: drop the body focus from the subject's Escape — focus falls out of the reply to the
     list, and (with `data-key-writing` gone too) `e` parks the message and drops the file.
     Where the subject's Escape hands the keyboard is the case after this one (write's owed key); this one holds what
     a letter typed after it does. */
  it("Escape in the subject returns to the body; a typed e parks nothing and keeps the file", async () => {
    await replyWithFile();
    const subject = openSubject();
    await intoSubject();

    await keyAtFocus("Escape");
    expect(replySurface(), "the subject's Escape closed the reply").not.toBeNull();

    await keyAtFocus("e");
    expect(parked(), "a letter typed after the subject's Escape parked the message").toBe(false);
    expect(replySurface(), "the letter closed the reply").not.toBeNull();
    expect(reply()!.textContent, "the attached file was dropped").toContain("notes.txt");
    expect(openSubject(), "the message being answered left the screen").toBe(subject);
  });

  /* SPLIT OUT of the case above, its lines as they stood but the one the studio made void (the subject is always
     drawn, so Escape cannot close it): the subject's Escape hands the keyboard to the reply's text. */
  it("Escape in the subject hands the keyboard to the reply's body", async () => {
    const surface = await replyWithFile();
    await intoSubject();
    await keyAtFocus("Escape");
    expect(surface.contains(document.activeElement), "Escape did not hand focus to the reply's body").toBe(true);
  });

  /* Mutation: drop the reply's `data-key-writing` — `e` on a button inside the reply runs the
     mailbox's park on the message behind it. */
  it("no mailbox letter runs from a control inside the open reply", async () => {
    await replyWithFile();
    const subject = openSubject();
    // A control of the reply's own head: the press that unfolds whom it goes to.
    const own = reply()?.querySelector<HTMLButtonElement>('button[aria-label="Change recipients"]') ?? null;
    expect(own, "the reply drew no control of its own").not.toBeNull();
    await act(async () => { own!.focus(); });
    expect(document.activeElement, "the reply's control did not take focus").toBe(own);
    await keyAtFocus("e");
    expect(parked(), "e on the reply's own button parked the message").toBe(false);
    expect(replySurface(), "the letter closed the reply").not.toBeNull();
    expect(reply()!.textContent).toContain("notes.txt");
    expect(openSubject()).toBe(subject);
  });

  /* Mutation: drop the writing-surface landing in `focus-follows` — the removed button's focus
     falls to the list's row, and `e` there parks the message and drops the other file. */
  it("removing a file by keyboard keeps focus in the reply; a typed e parks nothing", async () => {
    const surface = await replyWithFile(["one.txt", "two.txt"]);
    const subject = openSubject();
    const remove = reply()?.querySelector<HTMLButtonElement>('button[aria-label="Remove two.txt"]') ?? null;
    expect(remove, "no remove control for two.txt").not.toBeNull();
    await act(async () => { remove!.focus(); });
    await act(async () => { remove!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(reply()!.textContent, "the file was not removed").not.toContain("two.txt");
    expect(surface.contains(document.activeElement), "the removed button's focus left the reply").toBe(true);

    await keyAtFocus("e");
    expect(parked(), "a letter typed after removing a file parked the message").toBe(false);
    expect(replySurface(), "the letter closed the reply").not.toBeNull();
    expect(reply()!.textContent, "the other file was dropped").toContain("one.txt");
    expect(openSubject(), "the message being answered left the screen").toBe(subject);
  });

  /* The control: the same `e` parks once the reply is closed, so the cases above measure a claim. */
  it("the mailbox letters come back when the reply closes", async () => {
    await replyWithFile();
    await cancelReply();
    expect(replySurface()).toBeNull();
    await key("e");
    await waitFor(parked, "e did not park the message with the reply closed");
  });
});

describe("the dock wrapper is conditional at the source", () => {
  /**
   * The rendered guard above can only see the demo's own width. This pins the RULE, so the
   * wrapper cannot become unconditional in a build where no test happens to open a reply — the
   * `screener-row-actions-overlay.test.ts` idiom, and `readFileSync` for the reason its header
   * gives about this repo's `grep`.
   */
  it("`ReadingPane` renders `.reply-dock` only when there is a reply", () => {
    /* RE-POINTED BY PATH: the reply's sheet is `write`'s (`ReplySheet`, which the reader draws in its slot after the
       conversation's last letter); today's `ReadingPane` and its dock wrapper leave with today's shell. */
    const src = readFileSync(
      resolve(process.cwd(), fromRootOrApp("packages/app/src/write/Reply.tsx")),
      "utf8",
    );
    expect(
      src,
      "the reply dock is no longer conditional — it would outlive the editor it wraps",
    ).toMatch(/const reply = w\.reply;\s*if \(reply === null \|\| !letters\.includes\(reply\.messageId\)\) return null;/);
  });
});

/** The repo root from either working directory — the root run is what CI does. */
function fromRootOrApp(relFromRoot: string): string {
  try {
    readFileSync(resolve(process.cwd(), relFromRoot), "utf8");
    return relFromRoot;
  } catch {
    return `../../${relFromRoot}`;
  }
}
