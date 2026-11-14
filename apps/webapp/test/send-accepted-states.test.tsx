/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { SendStatus } from "../app/shell/SendStatus.js";
import { SENDING_LONG_MS, sendVerb, type SendState } from "../app/shell/mail-send.js";

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
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(send: SendState, messages: typeof en | typeof de, locale: string): string {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <NextIntlClientProvider locale={locale} messages={messages as never} timeZone="UTC">
        <SendStatus send={send} scope="reply" lane={null} showing={null} />
      </NextIntlClientProvider>,
    );
  });
  return host.textContent ?? "";
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("the server's accepted-pending send is not the transport's queued one", () => {
  it("accepted reads as a send still going, never as one that may not have arrived — en", () => {
    // NOT `statusAccepted`: that string says "ohmail sends it on its next pass" and no pass
    // claims an interactive row (`claimDue` needs a `send_key` a manual send never has). What is
    // true is that the server holds the reservation and the submission is still in flight, which
    // is the same condition a long send is in — so it says that.
    const text = render({ phase: "queued", accepted: true }, en, "en");
    expect(text).toBe(en.reply.statusSendingLong);
    expect(text, "the surface claimed a pass that will never look at this row")
      .not.toContain("next pass");
  });

  it("accepted reads as a send still going, never as one that may not have arrived — de", () => {
    const text = render({ phase: "queued", accepted: true }, de, "de");
    expect(text).toBe(de.reply.statusSendingLong);
    expect(text).not.toContain("Durchlauf");
  });

  it("a queued send with NO accepted flag never claims acceptance — en", () => {
    const text = render({ phase: "queued" }, en, "en");
    expect(text).toBe(en.reply.statusQueued);
    expect(
      text,
      "a request that may never have arrived was reported as still on its way",
    ).not.toBe(en.reply.statusSendingLong);
  });

  it("a queued send with NO accepted flag never claims acceptance — de", () => {
    const text = render({ phase: "queued" }, de, "de");
    expect(text).toBe(de.reply.statusQueued);
    expect(text).not.toBe(de.reply.statusSendingLong);
  });
});

describe("a send that is still going says so", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("swaps to the long-send line at the threshold, and not before", async () => {
    const since = Date.now();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <NextIntlClientProvider locale="en" messages={en as never} timeZone="UTC">
          <SendStatus send={{ phase: "sending", since }} scope="reply" lane={null} showing={null} />
        </NextIntlClientProvider>,
      );
    });

    expect(host.textContent, "the opening line is the one a normal send shows")
      .toBe(en.reply.statusSending);

    await act(async () => { await vi.advanceTimersByTimeAsync(SENDING_LONG_MS - 1); });
    expect(host.textContent, "the line changed before the threshold").toBe(en.reply.statusSending);

    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(host.textContent, "a send past the threshold still says nothing new")
      .toBe(en.reply.statusSendingLong);
  });

  it("a send ALREADY past the threshold when it renders says so immediately", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <NextIntlClientProvider locale="en" messages={en as never} timeZone="UTC">
          <SendStatus send={{ phase: "sending", since: Date.now() - SENDING_LONG_MS - 1 }} scope="reply" lane={null} showing={null} />
        </NextIntlClientProvider>,
      );
    });
    // The surface can be re-rendered mid-send (a re-mount, a parent update). Deriving from the
    // phase's own stamp rather than from this component's lifetime is what makes that case right.
    expect(host.textContent).toBe(en.reply.statusSendingLong);
  });
});

describe("the button's word and its state attribute come from one derivation", () => {
  it("only the three phases the stylesheet paints ever carry the attribute", () => {
    expect(sendVerb({ phase: "idle" }, "compose")).toEqual({ key: "send" });
    expect(sendVerb({ phase: "sending" }, "compose")).toEqual({ key: "sending", attr: "sending" });
    expect(sendVerb({ phase: "sent" }, "compose")).toEqual({ key: "sent", attr: "sent" });
    expect(sendVerb({ phase: "queued" }, "compose")).toEqual({ key: "queued", attr: "queued" });
    // Back to rest: Send is the retry, and an attribute the stylesheet has no rule for would be
    // a claim in the DOM that nothing is making.
    expect(sendVerb({ phase: "failed" }, "compose")).toEqual({ key: "send" });
    expect(sendVerb({ phase: "unverified" }, "compose")).toEqual({ key: "send" });
  });

  it("a send-later confirm says Scheduled on the compose form and Sent on a reply", () => {
    // Nothing was sent; an appointment was made. "Sent" over it is the false claim the phase
    // machine exists to prevent — and the reply scope has no `scheduled` key to render at all,
    // so asking for one there would put a key's own name in front of a reader.
    expect(sendVerb({ phase: "sent", scheduled: true }, "compose")).toEqual({ key: "scheduled", attr: "sent" });
    expect(sendVerb({ phase: "sent", scheduled: true }, "reply")).toEqual({ key: "sent", attr: "sent" });
  });

  it("every key the verb can name exists in BOTH locales, in both scopes it is used in", () => {
    // The compose form is the only scope that can reach `scheduled`; the guard says so rather
    // than asserting a key the reply catalogue deliberately does not carry.
    for (const [messages, name] of [[en, "en"], [de, "de"]] as const) {
      for (const scope of ["compose", "reply"] as const) {
        const states: SendState[] = [
          { phase: "idle" }, { phase: "sending" }, { phase: "sent" },
          { phase: "queued" }, { phase: "failed" }, { phase: "unverified" },
          ...(scope === "compose" ? [{ phase: "sent", scheduled: true } as SendState] : []),
        ];
        for (const state of states) {
          const { key } = sendVerb(state, scope);
          // Read as `unknown` and narrowed by the assertion, NOT cast to a two-level record: the
          // catalogue nests deeper than that in other scopes (`screener.empty.waiting.title`), so
          // the direct cast does not overlap and `apps/webapp` — one of the four packages that
          // typecheck their TESTS — fails the whole gate on it.
          const catalogue = messages as unknown as Record<string, Record<string, unknown>>;
          expect(
            catalogue[scope]?.[key],
            `${name}.${scope}.${key} is missing — the button would render the key's own name`,
          ).toBeTypeOf("string");
        }
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
  async function compose(o: {
    kept: { kept: boolean; days: number | null } | null; files: boolean; onSendLater?: (iso: string) => void;
    filesNotKept?: number; forwardOf?: string;
  }): Promise<{
    setFiles: (files: boolean) => Promise<void>;
  }> {
    const { ComposeView } = await import("../app/views/ComposeView.js");
    const { EMPTY_COMPOSE, composePlan } = await import("../app/shell/compose.js");
    const { MemoryMirrorStore, OhmailEngine } = await import("@ohmail/client-engine");
    const { FixturesAdapter } = await import("@ohmail/testing/adapter");
    const { ToastHost } = await import("@ohmail/ui");
    const { KeymapProvider } = await import("../app/shell/keymap.js");
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const adapter = Object.assign(new FixturesAdapter(), { scheduleFilesAnnounced: async () => o.kept });
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore() });
    const from = {
      mailboxId: "mb-1", address: "me@fake.test", choices: [], substituted: false, substitutedFrom: null,
      maxMessageBytes: null, domainMatched: false,
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const draw = async (files: boolean): Promise<void> => {
      const fields = {
        ...EMPTY_COMPOSE, to: "ada@fake.test", subject: "later", body: "words", attachments: files ? [FILE] : [],
        ...(o.forwardOf ? { forwardOf: o.forwardOf } : {}),
      };
      await act(async () => {
        root!.render(
          <NextIntlClientProvider locale="en" messages={en as never} timeZone="UTC">
            <ToastHost><KeymapProvider>
            <ComposeView
              engine={engine} draft={null} fields={fields} onFields={() => {}} from={from as never}
              plan={composePlan(fields, "mb-1")} send={{ phase: "idle" }} showing={null}
              onSend={() => {}} onSendLater={o.onSendLater ?? (() => {})} onCancel={() => {}} onClose={() => {}}
              filesNotKept={o.filesNotKept ?? null}
            />
            </KeymapProvider></ToastHost>
          </NextIntlClientProvider>,
        );
      });
      for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
    };
    await draw(o.files);
    return { setFiles: draw };
  }
  const toggle = (): HTMLButtonElement => host!.querySelector<HTMLButtonElement>(".send-later-toggle")!;
  const presets = (): string[] => [...host!.querySelectorAll(".send-later .gate-actions button")].map((b) => b.textContent ?? "");
  const panelText = (): string => host!.querySelector(".send-later")?.textContent ?? "";

  it("where the door keeps files, a pick schedules the letter with them", async () => {
    const picked: string[] = [];
    await compose({ kept: DESKTOP, files: true, onSendLater: (iso) => picked.push(iso) });
    expect(toggle().disabled).toBe(false);
    await act(async () => { toggle().click(); });
    const tomorrow = [...host!.querySelectorAll<HTMLButtonElement>(".send-later .gate-actions button")]
      .find((b) => b.textContent?.startsWith("Tomorrow"));
    expect(tomorrow, "no times were offered").toBeDefined();
    expect(panelText()).toContain(en.compose.sendLaterThisComputer);
    await act(async () => { tomorrow!.click(); });
    expect(picked).toHaveLength(1);
  });

  for (const kept of [{ kept: false, days: null }, null] as const) {
    it(`where the door ${kept !== null ? "says it keeps none" : "cannot say"}, the panel says so in words and offers no time`, async () => {
      const picked: string[] = [];
      await compose({ kept, files: true, onSendLater: (iso) => picked.push(iso) });
      expect(toggle().disabled, "the reason must be reachable, not hidden in a title").toBe(false);
      await act(async () => { toggle().click(); });
      expect(panelText()).toContain(kept !== null ? en.compose.sendLaterFilesNotHere : en.compose.sendLaterUnavailable);
      expect(presets()).toEqual([en.compose.sendLaterClose]);
      expect(host!.querySelector("#compose-send-at")).toBeNull();
      expect(picked).toEqual([]);
    });
  }

  it("a file attached while the panel is open swaps the times for the sentence", async () => {
    const view = await compose({ kept: { kept: false, days: null }, files: false });
    await act(async () => { toggle().click(); });
    expect(presets().some((p) => p.startsWith("Tomorrow"))).toBe(true);
    await view.setFiles(true);
    expect(panelText()).toContain(en.compose.sendLaterFilesNotHere);
    expect(presets()).toEqual([en.compose.sendLaterClose]);
  });

  it("a pick while a file is still being read waits for it, then carries both files", async () => {
    // The probe's form: onFields re-renders, so a committed read reaches the form as it does live.
    const { ComposeView } = await import("../app/views/ComposeView.js");
    const { EMPTY_COMPOSE, composePlan } = await import("../app/shell/compose.js");
    const { MemoryMirrorStore, OhmailEngine } = await import("@ohmail/client-engine");
    const { FixturesAdapter } = await import("@ohmail/testing/adapter");
    const { ToastHost } = await import("@ohmail/ui");
    const { KeymapProvider } = await import("../app/shell/keymap.js");
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const adapter = Object.assign(new FixturesAdapter(), { scheduleFilesAnnounced: async () => ({ kept: true, days: null }) });
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore() });
    const from = { mailboxId: "mb-1", address: "me@fake.test", choices: [], substituted: false, substitutedFrom: null, maxMessageBytes: null, domainMatched: false };
    const picks: string[][] = [];
    let fields = { ...EMPTY_COMPOSE, to: "ada@fake.test", subject: "later", body: "words", attachments: [FILE] };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const draw = (): void => root!.render(
      <NextIntlClientProvider locale="en" messages={en as never} timeZone="UTC">
        <ToastHost><KeymapProvider>
        <ComposeView
          engine={engine} draft={null} fields={fields} from={from as never}
          onFields={(next) => { fields = next as typeof fields; draw(); }}
          plan={composePlan(fields, "mb-1")} send={{ phase: "idle" }} showing={null}
          onSend={() => {}} onSendLater={() => picks.push((fields.attachments ?? []).map((a) => a.filename))}
          onCancel={() => {}} onClose={() => {}} filesNotKept={null}
        />
        </KeymapProvider></ToastHost>
      </NextIntlClientProvider>,
    );
    const settle = async (): Promise<void> => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); }); };
    const key = async (k: string, mods: KeyboardEventInit = {}): Promise<void> => {
      await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods })); });
    };
    await act(async () => { draw(); });
    await settle();
    await act(async () => { toggle().click(); });
    expect(presets().some((p) => p.startsWith("Tomorrow"))).toBe(true);

    let held: FileReader | null = null;
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) { held = this; });
    const input = host!.querySelector<HTMLInputElement>(".compose-attach input[type=file]")!;
    const pdf = new File([new Uint8Array([37, 80, 68, 70])], "invoice.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { configurable: true, get: () => [pdf] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(held, "the read is in flight").not.toBeNull();

    expect(panelText()).toContain("Still attaching invoice.pdf.");
    expect(presets().some((p) => p.startsWith("Tomorrow")), "no time is offered over a file still being read").toBe(false);
    expect(host!.querySelector("#compose-send-at")).toBeNull();
    await key("2");
    await key("Enter", { ctrlKey: true });
    await key("Enter", { metaKey: true });
    expect(picks, "nothing scheduled while the file is still being read").toEqual([]);

    Object.defineProperty(held!, "result", { configurable: true, get: () => "data:application/pdf;base64,JVBERg==" });
    await act(async () => { held!.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>); });
    await settle();
    read.mockRestore();
    const tomorrow = [...host!.querySelectorAll<HTMLButtonElement>(".send-later .gate-actions button")]
      .find((b) => b.textContent?.startsWith("Tomorrow"));
    expect(tomorrow, "the times come back once the read commits").toBeDefined();
    await act(async () => { tomorrow!.click(); });
    expect(picks).toEqual([["photo.png", "invoice.pdf"]]);
  });

  it("a row whose schedule ended unsent says its files were not kept, until they are attached again", async () => {
    const view = await compose({ kept: DESKTOP, files: false, filesNotKept: 2 });
    const said = "This message was scheduled with 2 files that were not kept. Attach them again before you send.";
    expect(host!.textContent).toContain(said);
    await view.setFiles(true);
    expect(host!.textContent).not.toContain(said);
  });

  describe("on a server that keeps files only so far ahead", () => {
    // A Wednesday morning: tomorrow 09:00 is under a day away and Monday 09:00 about five.
    beforeEach(() => { vi.useFakeTimers({ now: new Date("2026-11-04T10:00:00.000Z"), toFake: ["Date"] }); });
    afterEach(() => { vi.useRealTimers(); });
    const field = (): HTMLInputElement => host!.querySelector<HTMLInputElement>("#compose-send-at")!;

    it("offers no time past the horizon, caps the field there, and says how far", async () => {
      await compose({ kept: { kept: true, days: 1 }, files: true });
      await act(async () => { toggle().click(); });
      expect(presets().some((p) => p.startsWith("Tomorrow"))).toBe(true);
      expect(presets().some((p) => p.startsWith("Monday")), "a preset past the horizon was offered").toBe(false);
      expect(Date.parse(field().max)).toBeLessThanOrEqual(Date.parse("2026-11-05T10:00:00.000Z"));
      expect(panelText()).toContain("A message with files can be scheduled up to 1 day ahead.");
      expect(panelText()).not.toContain(en.compose.sendLaterThisComputer);
    });

    it("a time typed past it is refused in words before the pick", async () => {
      const picked: string[] = [];
      await compose({ kept: { kept: true, days: 1 }, files: true, onSendLater: (iso) => picked.push(iso) });
      await act(async () => { toggle().click(); });
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        set.call(field(), "2026-11-07T12:00");
        field().dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(panelText()).toContain("A message with files can be scheduled at most 1 day ahead. Pick a closer time.");
      const confirm = [...host!.querySelectorAll<HTMLButtonElement>(".send-later-custom button")].find((b) => b.textContent?.startsWith(en.compose.sendLaterConfirm));
      expect(confirm?.disabled).toBe(true);
      expect(picked).toEqual([]);
    });

    it("a file attached with the panel open takes the times past the horizon away", async () => {
      const view = await compose({ kept: { kept: true, days: 1 }, files: false });
      await act(async () => { toggle().click(); });
      expect(presets().some((p) => p.startsWith("Monday")), "a letter without files has no horizon").toBe(true);
      await view.setFiles(true);
      expect(presets().some((p) => p.startsWith("Monday"))).toBe(false);
      expect(panelText()).toContain("up to 1 day ahead");
    });
  });

  it("a forward is never scheduled, and its own sentence says so", async () => {
    await compose({ kept: DESKTOP, files: false, forwardOf: "m-1" });
    expect(toggle().disabled).toBe(true);
    expect(toggle().title).toBe(en.compose.sendLaterNoForwards);
  });
});
