/** @vitest-environment jsdom */
/**
 * THE NEW READER'S PARTS ON THE WEB (`reader-parts.tsx`).
 *
 * TODAY'S TWO DOORS FIT THE READER'S PORTS: the web shell's file door and picture door, as today's composition makes
 * them, are what the reader's `files` and `pictures` ports declare, and the reader's body entry is what its `body`
 * port takes. Held at the type level, by the type checker that reads the web's tests (`tsc -p
 * apps/webapp/tsconfig.json`): a member the reader comes to require that today's door lacks is red there.
 *
 * AND OVER THE NEW SHELL (the door `_mail-shell.tsx`), the reader's parts do what today's reader does, at the seated Ohbox as every web host
 * hands it: the Ohbox's own place, the reader's column beside its list, the reader the shell's (`todaysReader`), fed
 * by the composition above the panes (its one file door and one picture door, its one look, its one composer's
 * Reply, the presented mirror its lists read). A reply is written inside its thread and leaves once with the letter it answers; a forward carries its files;
 * the account's stored resurface hour is offered and a changed one kept; an invitation's note stands over its letter;
 * and no letter asks for a picture by itself while the account's word on pictures is not known: over the web's proxy
 * and over a host's own picture door (the desktop's), for a designed letter and for a prose one.
 */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { createElement as h, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { NONE } from "@ohmail/app/host";
import type { PictureSeam, ReaderFiles, ReaderParts } from "@ohmail/app/reader";
import { letterBody } from "@ohmail/app/reader/body";
import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import {
  mutationEffects, OhmailEngine,
  type MirrorStore, type SyncChange,
} from "@ohmail/client-engine";
import messages from "../../messages/en.json";
import type { AttachmentsChrome } from "../../app/shell/attachments";
import type { RemoteImagesChrome } from "../../app/shell/remote-images";
import { typeInto } from "../fixtures/rich-editor-driver";
import { act, consentTransport, msg, NOW, S, setup, storeWith, teardown, waitFor } from "../_view-shell";
import { message, mountShell, stubDom, unmountAll, type DraftShell } from "../_draft-shell.js";

describe("today's doors and the reader's ports", () => {
  it("today's file door is a ReaderFiles", () => {
    expectTypeOf<AttachmentsChrome>().toMatchTypeOf<ReaderFiles>();
  });

  it("today's picture door is a PictureSeam", () => {
    expectTypeOf<RemoteImagesChrome>().toMatchTypeOf<PictureSeam>();
  });

  it("the reader's body entry is what its body port takes", () => {
    expectTypeOf(letterBody).toMatchTypeOf<ReaderParts["body"]>();
  });
});

/* ── the new shell, at the seated Ohbox ──────────────────────────────────────────────────────────────────── */

/* The pictures' door exists only where the page has a proxy to name: this page has one, unless a case says none
   (a host that fetches pictures through a door of its own names no proxy). */
const page = vi.hoisted(() => ({ proxy: true }));
vi.mock("../../app/api-client", async (load) => {
  const real = await load<typeof import("../../app/api-client")>();
  return { ...real, API_BASE: "/api", apiConfigured: () => page.proxy };
});

const ROSTER: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const, organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

/** Three files on every letter, where a case asks for them. */
const PARTS = [
  { id: "a0000000-0000-4000-8000-000000000001", filename: "plan.pdf", contentType: "application/pdf", sizeBytes: 1000, inline: false },
  { id: "c0000000-0000-4000-8000-000000000003", filename: "budget.xlsx", contentType: "application/octet-stream", sizeBytes: 3000, inline: false },
];

interface Seated {
  readonly sent: EngineMutation[];
}

/** The new shell over a memory mirror, at the seated Ohbox, the address naming the open letter. */
async function seat(o: {
  letters: EngineMessage[];
  hash: string;
  consent?: ConsentTransport | typeof NONE;
  /** Each letter's html, where it has one; every letter's text is its own. */
  html?: Record<string, string>;
  text?: Record<string, string>;
  files?: boolean;
  /** A host's own picture door (the desktop's pipe): what it was asked, and what it recorded. */
  door?: { fetches: string[]; records: string[] };
}): Promise<Seated> {
  const store: MirrorStore = await storeWith(o.letters);
  const sent: EngineMutation[] = [];
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => {
        const page = S.pending;
        S.pending = [];
        return {
          changes: { creates: page, updates: [], moves: [], deletes: [] },
          cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (m: EngineMutation) => {
        sent.push(m);
        const changes = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++S.seq}` }).map((e) => ({
          type: e.type, op: e.entity === null ? "delete" : e.move ? "move" : "update",
          id: e.id, seq: ++S.seq, updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
        })) as SyncChange[];
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      fetchBody: async (id: string) => ({
        text: o.text?.[id] ?? `The text of ${id}.`, html: o.html?.[id] ?? null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
      ...(o.files === true ? {
        listAttachments: async (id: string) => PARTS.map((p) => ({ ...p, messageId: id })),
        fetchAttachment: async () => new Blob(["x"]),
        forwardPartsAnnounced: async () => true,
      } : {}),
    },
  } as never);
  S.store = store;
  S.engine = engine;
  window.location.hash = o.hash;
  const { MailShell: AppShell } = await import("../_mail-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  S.roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { children: h(ToastHost, {
        children: h(AppShell as never, {
          demo: false, engine, consentTransport: o.consent ?? consentTransport,
          mailboxFacts: async () => ROSTER,
          ...(o.door ? {
            imageWire: {
              fetch: async (messageId: string, url: string) => { o.door!.fetches.push(`${messageId} ${url}`); return null; },
              record: async (messageId: string) => { o.door!.records.push(messageId); },
            },
          } : {}),
        } as never),
      }) }),
    } as never));
  });
  return { sent };
}

/** The reader's column as a person meets it: the region named Open message. */
const reader = (): HTMLElement => screen.getByRole("region", { name: "Open message" });
const atTheReader = (): boolean => screen.queryByRole("region", { name: "Open message" }) !== null;
const panel = (): HTMLElement => within(reader()).getByRole("toolbar", { name: "Actions" });
const sends = (s: { readonly sent: EngineMutation[] }) =>
  s.sent.filter((m): m is Extract<EngineMutation, { kind: "mail_send" }> => m.kind === "mail_send");
async function rounds(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
}
async function press(el: Element | null, what: string): Promise<void> {
  if (!el) throw new Error(`nothing to press: ${what}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
/** Every srcdoc of the reader's letters: what the frames were handed to draw. */
const framesOfTheReader = (): string =>
  [...reader().querySelectorAll("iframe")].map((f) => f.getAttribute("srcdoc") ?? "").join("\n");

const width = { w: 1024, h: 768 };
function sized(w: number, hgt: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: hgt });
}

beforeEach(() => {
  setup();
  width.w = window.innerWidth;
  width.h = window.innerHeight;
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(async () => {
  await teardown();
  sized(width.w, width.h);
  page.proxy = true;
});

describe("a reply, written inside its thread", () => {
  it("Reply opens today's editor under the letter, and Send leaves one send that answers that letter", async () => {
    sized(1440, 900);
    const s = await seat({ letters: [msg("m1")], hash: "#/ohbox/m/m1" });
    await waitFor(atTheReader, "the reader's column");
    await press(within(panel()).getByRole("button", { name: "Reply" }), "Reply");
    await waitFor(() => within(reader()).queryByRole("textbox", { name: "Reply body" }) !== null, "the editor in the reader");
    await act(async () => { typeInto(within(reader()).getByRole("textbox", { name: "Reply body" }), "See you then"); });
    await press(within(reader()).getByRole("button", { name: "Send" }), "Send");
    await waitFor(() => sends(s).length > 0, "the send");
    await rounds(10);
    expect(sends(s).map((m) => [m.inReplyTo, m.forwardOf ?? null]), "one send, answering m1").toEqual([["m1", null]]);
  }, 30_000);

  it("a letter's own menu answers that letter, not the conversation's newest", async () => {
    sized(1440, 900);
    const thread = { threadId: "t-a" };
    const s = await seat({
      letters: [
        msg("a1", { ...thread, date: "2026-09-15T08:00:00.000Z", updatedAt: "2026-09-15T08:00:00.000Z" }),
        msg("a2", { ...thread, date: "2026-09-16T08:00:00.000Z", updatedAt: "2026-09-16T08:00:00.000Z" }),
      ],
      hash: "#/ohbox/m/a2",
    });
    await waitFor(() => atTheReader() && within(reader()).queryAllByRole("article").length === 2, "both letters");
    const first = within(reader()).getAllByRole("article")[0]!;
    await press(within(first).getByRole("button", { name: "Message" }), "the first letter's menu");
    await press(screen.getByRole("menuitem", { name: "Reply" }), "Reply");
    await waitFor(() => within(reader()).queryByRole("textbox", { name: "Reply body" }) !== null, "the editor");
    await act(async () => { typeInto(within(reader()).getByRole("textbox", { name: "Reply body" }), "On the first"); });
    await press(within(reader()).getByRole("button", { name: "Send" }), "Send");
    await waitFor(() => sends(s).length > 0, "the send");
    await rounds(10);
    expect(sends(s).map((m) => m.inReplyTo), "the first letter answered").toEqual(["a1"]);
  }, 30_000);

  it("Reply on the panel, then Reply in that letter's own menu: the editor still stands, its words kept (the panel's Reply is the toggle)", async () => {
    sized(1440, 900);
    await seat({ letters: [msg("m1")], hash: "#/ohbox/m/m1" });
    await waitFor(atTheReader, "the reader's column");
    const editor = (): HTMLElement | null => within(reader()).queryByRole("textbox", { name: "Reply body" });
    await press(within(panel()).getByRole("button", { name: "Reply" }), "Reply on the panel");
    await waitFor(() => editor() !== null, "the editor in the reader");
    await act(async () => { typeInto(editor()!, "Half a thought"); });

    await press(within(within(reader()).getByRole("article")).getByRole("button", { name: "Message" }), "the letter's own menu");
    await press(screen.getByRole("menuitem", { name: "Reply" }), "Reply in the menu");
    await rounds(8);
    expect(editor(), "the menu's Reply answers THIS letter: it never closes its editor").not.toBeNull();
    expect(editor()!.textContent, "and what was typed is there").toContain("Half a thought");

    /* While a reply stands the panel is the reply's (Send, Discard: the studio's); its own close is Escape in it
       (the switch's Write, as `inline-reply`'s re-pointed cases): it closes the editor it opened. */
    await act(async () => { fireEvent.keyDown(editor()!, { key: "Escape" }); });
    await waitFor(() => editor() === null, "the panel's Reply closes the editor it opened");
  }, 30_000);

  it("Forward opens today's forward under the letter with the letter's files, and its send carries them", async () => {
    sized(1440, 900);
    const s = await seat({ letters: [msg("m1")], hash: "#/ohbox/m/m1", files: true });
    await waitFor(atTheReader, "the reader's column");
    await press(within(panel()).getByRole("button", { name: "Forward" }), "Forward");
    await waitFor(() => within(reader()).queryByRole("textbox", { name: "Forward body" }) !== null, "the forward");
    /* The letter's own tile, and the forward's list of the files it carries. */
    await waitFor(() => within(reader()).queryAllByText("plan.pdf").length > 1, "the letter's files in the forward");
    /* The people line's field, the kit's: a person is made of what was typed by Enter. */
    const to = within(reader()).getByRole("combobox", { name: "To" }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(to, { target: { value: "mila@example.invalid, " } });
    });
    await act(async () => { fireEvent.keyDown(to, { key: "Enter" }); });
    await act(async () => { typeInto(within(reader()).getByRole("textbox", { name: "Forward body" }), "For you"); });
    await press(within(reader()).getByRole("button", { name: "Send" }), "Send");
    await waitFor(() => sends(s).length > 0, "the send");
    await rounds(10);
    const [forward] = sends(s);
    expect([forward?.forwardOf, forward?.inReplyTo ?? null], "a forward of m1, answering nothing").toEqual(["m1", null]);
    expect(forward, "nothing removed: every file of the letter leaves with it").not.toHaveProperty("forwardParts");
  }, 30_000);
});

describe("a reply's send, with the send held on the wire", () => {
  const said = (): string => screen.queryAllByRole("status").map((n) => n.textContent ?? "").join(" | ");
  function holdTheSend(s: DraftShell): () => void {
    let release!: () => void;
    s.sendGate.wait = new Promise<void>((r) => { release = r; });
    return () => {
      s.sendGate.wait = null;
      release();
    };
  }
  beforeEach(() => {
    stubDom();
  });
  afterEach(async () => {
    await unmountAll();
  });

  for (const [w, hgt] of [[1440, 900], [390, 844]] as const) {
    it(`at ${w} wide the send's line stands in the notice slot while it is on its way, and one send answers the letter`, async () => {
      sized(w, hgt);
      const s = await mountShell("#/ohbox/m/m1", [message("m1")]);
      await waitFor(atTheReader, "the reader");
      await press(within(panel()).getByRole("button", { name: "Reply" }), "Reply");
      await waitFor(() => within(reader()).queryByRole("textbox", { name: "Reply body" }) !== null, "the editor in the reader");
      await act(async () => { typeInto(within(reader()).getByRole("textbox", { name: "Reply body" }), "Noted, thanks"); });
      const release = holdTheSend(s);
      await press(within(reader()).getByRole("button", { name: "Send" }), "Send");
      await waitFor(() => sends(s).length === 1, "the send on the wire");
      /* The send line's words: the new Write's one send line (its catalogue's \`write.status.sending\`). */
      const onItsWay = (): boolean => said().includes(messages.write.status.sending);
      await waitFor(onItsWay, "the notice slot says the reply is on its way");
      await act(async () => { release(); });
      await waitFor(() => !onItsWay(), "the send answered");
      await rounds(10);
      expect(sends(s).map((m) => [m.inReplyTo ?? null, m.forwardOf ?? null]), "one send, answering m1").toEqual([["m1", null]]);
    }, 60_000);
  }

  it("Reply all from the panel: one send answering the letter, the other person on it", async () => {
    sized(1440, 900);
    const s = await mountShell("#/ohbox/m/m1", [
      message("m1", { cc: [{ address: "ann@example.invalid", name: "Ann" }] } as never),
    ]);
    await waitFor(atTheReader, "the reader");
    await waitFor(() => within(panel()).queryByRole("button", { name: /Reply all/ }) !== null, "Reply all on the panel");
    await press(within(panel()).getByRole("button", { name: /Reply all/ }), "Reply all");
    await waitFor(() => within(reader()).queryByRole("textbox", { name: "Reply body" }) !== null, "the editor");
    await act(async () => { typeInto(within(reader()).getByRole("textbox", { name: "Reply body" }), "To you both"); });
    await press(within(reader()).getByRole("button", { name: "Send" }), "Send");
    await waitFor(() => sends(s).length > 0, "the send");
    await rounds(10);
    const [send] = sends(s);
    expect(sends(s), "one send").toHaveLength(1);
    expect(send?.inReplyTo, "the letter answered").toBe("m1");
    expect([...(send?.to ?? []), ...(send?.cc ?? [])].map((p) => p.address), "Ann is on it").toContain("ann@example.invalid");
  }, 60_000);

  it("Forward from an older letter's own menu: one forward of that letter, every file with it", async () => {
    sized(1440, 900);
    const thread = { threadId: "t-f" };
    const s = await mountShell("#/ohbox/m/f2", [
      message("f1", { ...thread, date: "2026-09-26T08:00:00.000Z", updatedAt: "2026-09-26T08:00:00.000Z" } as never),
      message("f2", { ...thread, date: "2026-09-27T08:00:00.000Z", updatedAt: "2026-09-27T08:00:00.000Z" } as never),
    ], [], { parts: true });
    await waitFor(() => atTheReader() && within(reader()).queryAllByRole("article").length === 2, "both letters");
    const first = within(reader()).getAllByRole("article")[0]!;
    await press(within(first).getByRole("button", { name: "Message" }), "the first letter's menu");
    await press(screen.getByRole("menuitem", { name: "Forward" }), "Forward");
    await waitFor(() => within(reader()).queryByRole("textbox", { name: "Forward body" }) !== null, "the forward");
    const to = within(reader()).getByRole("combobox", { name: "To" }) as HTMLInputElement;
    await act(async () => { fireEvent.change(to, { target: { value: "mila@example.invalid, " } }); });
    await act(async () => { fireEvent.keyDown(to, { key: "Enter" }); });
    await act(async () => { typeInto(within(reader()).getByRole("textbox", { name: "Forward body" }), "For you"); });
    await press(within(reader()).getByRole("button", { name: "Send" }), "Send");
    await waitFor(() => sends(s).length > 0, "the send");
    await rounds(10);
    const [forward] = sends(s);
    expect(sends(s), "one send").toHaveLength(1);
    expect([forward?.forwardOf, forward?.inReplyTo ?? null], "a forward of the first letter").toEqual(["f1", null]);
    expect(forward?.forwardParts, "every file of the letter leaves with it").toBeUndefined();
  }, 60_000);
});

describe("the account's resurface hour", () => {
  const stored = { at: "07:30" as string | null, kept: [] as Array<string | null> };
  const withHour: ConsentTransport = {
    ...consentTransport,
    state: async () => ({ ...(await consentTransport.state()), resurfaceTime: stored.at }),
    setResurfaceTime: async (hhmm: string | null) => {
      stored.kept.push(hhmm);
      return { resurfaceTime: hhmm };
    },
  } as unknown as ConsentTransport;
  beforeEach(() => {
    stored.at = "07:30";
    stored.kept = [];
  });
  const time = (): HTMLInputElement => screen.getByLabelText("Time", { selector: "input" }) as HTMLInputElement;

  it("is offered as the row says, and a changed hour after a dated answer is written once through the row", async () => {
    sized(1440, 900);
    const s = await seat({ letters: [msg("m1")], hash: "#/ohbox/m/m1", consent: withHour });
    await waitFor(atTheReader, "the reader's column");
    await rounds(6);
    await press(within(panel()).getByRole("button", { name: "Resurface" }), "Resurface");
    await waitFor(() => time().value === "07:30", "the stored hour offered");
    await act(async () => { fireEvent.change(time(), { target: { value: "10:15" } }); });
    await press(screen.getByRole("menuitem", { name: /^Tomorrow/ }), "Tomorrow");
    await waitFor(() => stored.kept.length > 0, "the hour kept");
    await rounds(6);
    expect(stored.kept, "written once, the changed hour").toEqual(["10:15"]);
    expect(s.sent.filter((m) => m.kind === "triage_set").map((m) => (m as { state?: string }).state)).toEqual([
      "bubbled_up",
    ]);
  }, 30_000);

  it("over a host with no consent wire 09:00 is offered and nothing is written", async () => {
    sized(1440, 900);
    const s = await seat({ letters: [msg("m1")], hash: "#/ohbox/m/m1", consent: NONE });
    await waitFor(atTheReader, "the reader's column");
    await press(within(panel()).getByRole("button", { name: "Resurface" }), "Resurface");
    expect(time().value).toBe("09:00");
    await act(async () => { fireEvent.change(time(), { target: { value: "10:15" } }); });
    await press(screen.getByRole("menuitem", { name: /^Tomorrow/ }), "Tomorrow");
    await waitFor(() => s.sent.some((m) => m.kind === "triage_set"), "the letter booked");
    await rounds(6);
    expect(stored.kept, "nothing written anywhere").toEqual([]);
  }, 30_000);
});

describe("what today's reader says of an invitation", () => {
  it("the note stands over the letter that carries one, outside its text, and says nothing over another", async () => {
    sized(1440, 900);
    const thread = { threadId: "t-i" };
    await seat({
      letters: [
        msg("i1", { ...thread, date: "2026-09-15T08:00:00.000Z", invitationWithoutEvent: true } as never),
        msg("i2", { ...thread, date: "2026-09-16T08:00:00.000Z" }),
      ],
      hash: "#/ohbox/m/i2",
    });
    await waitFor(() => atTheReader() && within(reader()).queryAllByRole("article").length === 2, "both letters");
    const [first, second] = within(reader()).getAllByRole("article");
    const note = within(first!).getByText(messages.body.invitationWithoutEvent);
    expect(note.closest("[data-read-body]"), "the note is not inside the letter's text").toBeNull();
    const text = first!.querySelector("[data-read-body]")!;
    expect(note.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING, "the text follows the note").toBeTruthy();
    expect(within(second!).queryByText(messages.body.invitationWithoutEvent)).toBeNull();
  }, 30_000);

  it("an Outlook Web App stub says where to change it, by the fixed settings address, never the letter's own", async () => {
    sized(1440, 900);
    const BASE = "https://outlook.office365.com/owa/tenant.example/";
    const STUB = [
      "Microsoft Outlook Web Access:",
      `${BASE}?itemid=AAMkADJh%2FTaHJ8AAV95f1jAAA%3D&exvsurl=1&path=/calendar/item`,
      "",
      "To receive meeting invitations as .iCalendar attachments instead of Outlook Web App links, go to",
      `${BASE}?path=/options/popandimap&extra=1 and select Send meeting invitations in iCalendar format.`,
    ].join("\n");
    await seat({ letters: [msg("o1")], hash: "#/ohbox/m/o1", text: { o1: STUB } });
    await waitFor(() => atTheReader() && within(reader()).queryByRole("link", {
      name: messages.body.invitationOwaOpenSetting,
    }) !== null, "the note with its way to the setting");
    const link = within(reader()).getByRole("link", { name: messages.body.invitationOwaOpenSetting });
    expect(link.getAttribute("href")).toBe("https://outlook.office365.com/owa/?path=/options/popandimap");
  }, 30_000);
});

describe("pictures, by the account's word alone", () => {
  const PICTURE = "https://pictures.example/hero.png";
  const HTML = `<table width="600"><tr><td><p>hello</p><img src="${PICTURE}" width="600" height="200"></td></tr></table>`;
  /* A letter of words with a picture among them: drawn in the page, not in a frame of its own. */
  const PROSE = `<p>Hi there, a picture in the words: <img src="https://pictures.example/inline.png" width="320" height="120"> and more words after it so it reads as prose.</p><p>A second paragraph.</p>`;
  const BOTH = { letters: [msg("p1"), msg("p2", { date: "2026-09-16T08:28:00.000Z" })], html: { p1: HTML, p2: PROSE } };
  /** What the reader's own nodes would make a browser fetch: the sender's address or the proxy's, in a fetching place. */
  const askedInThePage = (): string[] =>
    [...reader().querySelectorAll("*")].flatMap((el) =>
      [...el.attributes]
        .filter((a) => /^(src|srcset|background|poster|data-ohmail-(src|style|sheet|css-src))$/.test(a.name) || (a.name === "style" && /url\(/i.test(a.value)))
        .filter((a) => /pictures\.example|\/img\?/.test(a.value))
        .map((a) => `${el.tagName.toLowerCase()} ${a.name}`));
  async function open(id: string): Promise<void> {
    await act(async () => {
      window.location.hash = `#/ohbox/m/${id}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => atTheReader() && reader().querySelector(`[data-conv-id="${id}"]`) !== null, `the letter ${id}`);
    await rounds(10);
  }

  for (const [w, hgt] of [[1440, 900], [390, 844]] as const) {
    it(`at ${w} wide, over a host with no consent wire, no letter asks for a picture by itself`, async () => {
      sized(w, hgt);
      await seat({ letters: [msg("p1")], hash: "#/ohbox/m/p1", consent: NONE, html: { p1: HTML } });
      await waitFor(() => atTheReader() && reader().querySelector("iframe") !== null, "the letter drawn");
      await rounds(10);
      expect(screen.getAllByRole("region", { name: "Open message" }), "one reader on screen").toHaveLength(1);
      expect(framesOfTheReader()).not.toContain("/api/img?");
      expect(framesOfTheReader(), "nothing is asked of the sender either").not.toMatch(/src="https:\/\/pictures/);
    }, 30_000);
  }

  for (const [w, hgt] of [[1440, 900], [390, 844]] as const) {
    it(`at ${w} wide, a prose letter over a host with no consent wire asks for no picture either`, async () => {
      sized(w, hgt);
      await seat({ ...BOTH, hash: "#/ohbox/m/p2", consent: NONE });
      await open("p2");
      expect(askedInThePage(), "a picture asked for in the page").toEqual([]);
      expect(framesOfTheReader()).not.toContain("/api/img?");
    }, 30_000);

    for (const wire of ["no consent wire", "a consent wire before its answer"] as const) {
      it(`at ${w} wide, over a host's own picture door with ${wire}: a designed letter and a prose one opened, the door is never asked and records nothing`, async () => {
        sized(w, hgt);
        page.proxy = false;
        const door = { fetches: [] as string[], records: [] as string[] };
        const held = new Promise<Record<string, unknown>>(() => {});
        const consent = wire === "no consent wire" ? NONE : ({ ...consentTransport, state: () => held } as unknown as ConsentTransport);
        await seat({ ...BOTH, hash: "#/ohbox", consent, door });
        await waitFor(() => screen.queryAllByRole("option").length === 2, "the seated list");
        await open("p1");
        await open("p2");
        expect(door.fetches, "the door's fetcher asked").toEqual([]);
        expect(door.records, "a press recorded with nobody pressing").toEqual([]);
        expect(askedInThePage(), "a picture asked for in the page").toEqual([]);
      }, 30_000);
    }
  }

  it("over a host's own picture door, once the account's live answer says pictures load, the door is asked for the letter's picture", async () => {
    sized(1440, 900);
    page.proxy = false;
    const door = { fetches: [] as string[], records: [] as string[] };
    let answer!: (state: Record<string, unknown>) => void;
    const held = new Promise<Record<string, unknown>>((r) => { answer = r; });
    const live: ConsentTransport = { ...consentTransport, state: () => held } as unknown as ConsentTransport;
    await seat({ ...BOTH, hash: "#/ohbox/m/p1", consent: live, door });
    await open("p1");
    expect(door.fetches, "before the answer").toEqual([]);
    await act(async () => { answer({ ...(await consentTransport.state()), blockRemoteImagesAt: null }); });
    await waitFor(() => door.fetches.some((f) => f.includes("hero.png")), "the door asked for the picture");
  }, 30_000);

  it("before the account's live answer nothing loads; once it says pictures load, they come through the proxy", async () => {
    sized(1440, 900);
    let answer!: (state: Record<string, unknown>) => void;
    const held = new Promise<Record<string, unknown>>((r) => { answer = r; });
    const live: ConsentTransport = { ...consentTransport, state: () => held } as unknown as ConsentTransport;
    await seat({ letters: [msg("p1")], hash: "#/ohbox/m/p1", consent: live, html: { p1: HTML } });
    await waitFor(() => atTheReader() && reader().querySelector("iframe") !== null, "the letter drawn");
    await rounds(10);
    expect(framesOfTheReader(), "before the answer").not.toContain("/api/img?");
    await act(async () => { answer({ ...(await consentTransport.state()), blockRemoteImagesAt: null }); });
    await waitFor(() => framesOfTheReader().includes("/api/img?"), "the picture through the proxy");
    expect(framesOfTheReader(), "never from the sender").not.toMatch(/src="https:\/\/pictures/);
    expect(framesOfTheReader()).toContain("/api/img?mid=p1");
  }, 30_000);
});
