/** @vitest-environment jsdom */
/**
 * TRASH'S OWN SEAT, over the tests' door of a mount: the real registrations of `mailPlaces()` through the real `Frame`,
 * over the fake host that hands the mail ground above the panes. No shell is mounted and no context is provided by
 * hand (but in the demo's case: the engine's binding says the demo, as a shell's does, and the folders are said on,
 * since the demo's own consent row rests with them off): what the list draws is the engine's page of deleted mail,
 * what a press writes the frame's one seam sent, and the mail server's own Trash is the host's wire, read only where
 * the account uses folders and never in the demo.
 *
 * A restore is held for its Undo window and then asks the server to
 * put the letter back, by the press's own id, the server naming where; nothing the place offers erases a letter.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine, TrashRowWire } from "@ohmail/client-engine";
import type { EngineMutation } from "@ohmail/wire";
import { readingScroller } from "@ohmail/ui/mail";
import { ConsentContext, useConsent } from "@ohmail/app-logic/consent";
import { EngineContext } from "@ohmail/app-logic/engine";
import { useKeymap, type BoundKey } from "@ohmail/app-logic/keys";
import { takeDeleteIntents } from "@ohmail/app-logic/press/delete-intents";
import { LANDING_REST_MS } from "@ohmail/app-logic/reading/reader-seen";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import {
  trashLiveKeyOf,
  trashLiveState,
  type TrashLiveWire,
  type TrashWindowItemWire,
  type TrashWindowPageWire,
} from "@ohmail/app-logic/trash";
import { Frame } from "../../src/frame/Frame.js";
import { NONE, type ConsentWire, type HostReads } from "../../src/host/index.js";
import { MailGround, mailPlaces } from "../../src/mail/index.js";
import { paletteOver } from "../../src/palette/index.js";
import { TextProvider } from "../../src/text/index.js";
import folderEn from "../../messages/folder.en.json" with { type: "json" };
import searchEn from "../../messages/search.en.json" with { type: "json" };
import trashEn from "../../messages/trash.en.json" with { type: "json" };
import trashDe from "../../messages/trash.de.json" with { type: "json" };
import screenerEn from "../../messages/screener.en.json" with { type: "json" };
import { fakeMail, letter, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, type FakeAddress } from "../support/fake-window.js";

const T = trashEn.trash;
if (typeof globalThis.PointerEvent !== "function") {
  class PointerEventHere extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  globalThis.PointerEvent = PointerEventHere as unknown as typeof PointerEvent;
}
const HERE = fileURLToPath(import.meta.url);
/** The lines that try a delete, a move or a raw dispatch through what Trash's live hook takes. */
const TRIED = join(dirname(HERE), "no-erase.fixture.ts");

/** A letter ohmail deleted, as the server's page of Trash lists it: when, and where Restore puts it. */
function trashed(id: string, restoreTo: string): TrashRowWire {
  return {
    ...letter(id, { subject: `About ${id}`, unread: false }),
    trashedAt: "2026-11-16T08:00:00.000Z",
    restoreTo,
  };
}
const TWO = [trashed("t1", "INBOX"), trashed("t2", "Clients")];
const THREE = [...TWO, trashed("t3", "INBOX")];

/** A letter of the mail server's own Trash, as the host's wire lists it. */
function serverRow(uid: number, subject: string): TrashWindowItemWire {
  return {
    mailboxId: "mb",
    uid,
    uidValidity: "7",
    subject,
    from: { name: "Someone Else", address: "someone@ex.example" },
    date: "2026-11-16T07:00:00.000Z",
    messageIdHeader: null,
    seen: true,
    origin: "provider",
  };
}

/** The host's wire to the server's own Trash: every ask is written down, in order. */
function serverTrash(
  items: readonly TrashWindowItemWire[],
  asked: string[],
  body: () => Promise<{ subject: string; text: string }> = async () => ({
    subject: "s",
    text: "the text from the server",
  }),
): TrashLiveWire {
  return {
    list: async () => {
      asked.push("list");
      return {
        mailboxes: [{ id: "mb", address: "a@ex.example", window: "ok" }],
        items: [...items],
        nextCursor: null,
      };
    },
    body: async (_mailbox, uid) => {
      asked.push(`body:${uid}`);
      return body();
    },
  };
}

/** The account's consent row says it uses folders: the server's own Trash is read under it. */
const FOLDERS_ON = {
  state: async () => ({
    seedConfirmedAt: null,
    dormancyDays: 45,
    foldersEnabledAt: "2026-01-01T00:00:00.000Z",
  }),
} as unknown as ConsentWire;

interface RestoreAnswer {
  state: string;
  restoreTo?: string;
  pending?: boolean;
  code?: string;
  error?: string;
}
type Answer = (id: string) => RestoreAnswer | Promise<RestoreAnswer>;
const RESTORED: Answer = () => ({ state: "restored", restoreTo: "Clients", pending: true });

interface Bin {
  readonly engine: OhmailEngine;
  readonly pageRequests: Array<{ cursor?: string; limit?: number }>;
  /** Every mutation the seam sent through the engine. */
  readonly mutations: EngineMutation[];
  /** Every restore the server was asked for, by letter, and the press's id it went out under. */
  readonly restores: string[];
  readonly intents: string[];
  /** Every delete the engine was asked to send again. */
  readonly replayed: string[];
}

/**
 * An engine over the fake mirror whose Trash is the server's page: a letter the server restored leaves it. Its page
 * answers once `answered` has.
 */
function binOf(
  rows: readonly TrashRowWire[],
  answer: Answer,
  {
    answered = Promise.resolve(),
    available = true,
    mirrored = {},
  }: { answered?: Promise<unknown>; available?: boolean; mirrored?: Readonly<Record<string, unknown>> },
): Bin {
  const mail = fakeMail([], [], {}, mirrored);
  const inTrash = [...rows];
  const pageRequests: Bin["pageRequests"] = [];
  const restores: string[] = [];
  const intents: string[] = [];
  const replayed: string[] = [];
  const engine = {
    ...(mail.engine as unknown as Record<string, unknown>),
    searchIndexRevision: () => 0,
    warmSearchIndex: async () => undefined,
    serverSearchAvailable: () => false,
    serverAddressSearchAvailable: () => false,
    drainsCompleted: () => 0,
    messagesWith: () => ({ items: [], counts: { from: 0, to: 0, any: 0 }, indexing: false }),
    trashAvailable: () => available,
    listTrash: async (request: Bin["pageRequests"][number] = {}) => {
      pageRequests.push(request);
      await answered;
      return { state: "ready", items: [...inTrash], nextCursor: null };
    },
    restoreFromTrash: async (id: string, opts: { intentId: string }) => {
      restores.push(id);
      intents.push(opts.intentId);
      const said = await answer(id);
      const at = inTrash.findIndex((r) => r.id === id);
      if (said.state === "restored" && at >= 0) inTrash.splice(at, 1);
      return said;
    },
    replayDelete: async (id: string) => {
      replayed.push(id);
      return { status: "confirmed" };
    },
  } as unknown as OhmailEngine;
  return { engine, pageRequests, mutations: mail.mutations, restores, intents, replayed };
}

/** The key table as the frame's registry holds it at the moment. */
let table: readonly BoundKey[] = [];
function KeyTable(): null {
  table = useKeymap().bindings;
  return null;
}
/** The mail ground, with a reader of the key table beside the panes. */
function Ground({ children }: { readonly children: ReactNode }) {
  return (
    <MailGround>
      <KeyTable />
      {children}
    </MailGround>
  );
}
/** The account's folders said on under the ground's own row, whatever it answered. */
function FoldersOn({ children }: { readonly children: ReactNode }) {
  const row = useConsent();
  return (
    <ConsentContext.Provider value={{ ...row, foldersEnabled: true }}>{children}</ConsentContext.Provider>
  );
}
function GroundFoldersOn({ children }: { readonly children: ReactNode }) {
  return (
    <Ground>
      <FoldersOn>{children}</FoldersOn>
    </Ground>
  );
}

interface Seated extends Bin {
  readonly address: FakeAddress;
  readonly viewport: ReturnType<typeof fakeWindow>;
}
function seat(
  o: {
    rows?: readonly TrashRowWire[];
    room?: "desktop" | "phone" | "fold";
    first?: string;
    readerClosed?: boolean;
    wire?: TrashLiveWire;
    /** The consent wire answers that the account uses folders. */
    folders?: boolean;
    /** The folders said on above the panes whatever the row answered: the demo's own row rests with them off. */
    foldersOn?: true;
    /** The demo, as a shell's binding of the engine says it above the frame. */
    demo?: true;
    answer?: Answer;
    mailboxes?: HostReads["mailboxes"];
    available?: boolean;
    palette?: true;
    mirrored?: Readonly<Record<string, unknown>>;
    /** The engine's page of deleted mail answers only once this has: at once where it is left out. */
    answered?: Promise<unknown>;
  } = {},
): Seated {
  const bin = binOf(o.rows ?? TWO, o.answer ?? RESTORED, o);
  const address = fakeAddress(o.first ?? "#/trash");
  const viewport = fakeWindow(o.room ?? "desktop");
  if (o.readerClosed) Object.assign(address, { readerClosed: () => address.read() === "#/trash" });
  const { host } = fakeHost({
    engine: bin.engine,
    service: "self",
    scope: "acct-1",
    mailboxes: o.mailboxes ?? NONE,
    places: mailPlaces(),
    ...(o.palette ? { overs: { palette: paletteOver } } : {}),
    above: o.foldersOn ? GroundFoldersOn : Ground,
    window: viewport,
    address,
    wires: { trash: o.wire ?? NONE, consent: o.folders ? FOLDERS_ON : NONE },
  });
  const frame = <Frame host={host} />;
  const demo = { engine: bin.engine, demo: true, serverDemo: true, sync: SYNC_SETTLED };
  render(
    <TextProvider locale="en" messages={{ ...WORDS.en, ...folderEn }} timeZone="Europe/Zurich">
      {o.demo ? <EngineContext.Provider value={demo}>{frame}</EngineContext.Provider> : frame}
    </TextProvider>,
  );
  return { ...bin, address, viewport };
}

/** Lets the engine's and the wires' answers land, with the clock moved on where the case holds it. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}
const settled = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await settle();
};

/** A key on whatever has the keyboard, as a person presses it. */
const press = (key: string, more: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...more });
};
/** A row, found by the letter it carries. */
const option = (id: string): HTMLElement | undefined =>
  screen.queryAllByRole("option").find((o) => o.dataset.id === id);
/** The deleted letters Trash lists, in order. */
const listed = (): string[] => {
  const list = screen.queryByRole("listbox", { name: T.title });
  return list === null
    ? []
    : within(list)
        .queryAllByRole("option")
        .map((o) => o.dataset.id ?? "");
};
const reading = (): HTMLElement =>
  screen.queryByRole("dialog", { name: "Reading" }) ?? screen.getByRole("region", { name: "Reading" });
const panel = (): HTMLElement => within(reading()).getByRole("toolbar", { name: "Actions" });
/** What the frame's report slot and the place's own lines say now. */
const reported = (): string =>
  screen
    .queryAllByRole("status")
    .map((s) => s.textContent ?? "")
    .join(" | ");
/** A sentence of the catalogue as said, its closing mark left to the report's own drawing. */
const sentence = (s: string): string => s.replace(/[….]$/u, "");
/** What the seam sent, by kind, letter and read state. */
const sent = (bin: Bin): string[] =>
  bin.mutations.map((m) => {
    const r = m as { kind: string; messageIds?: string[]; messageId?: string; unread?: boolean };
    const how = r.unread === undefined ? "" : r.unread ? "unread" : "read";
    return [r.kind, r.messageId ?? r.messageIds?.join(",") ?? "", how].filter(Boolean).join(" ");
  });

beforeEach(() => {
  table = [];
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe("the transient rail entry and the two chords", () => {
  const goLabel = searchEn.shortcuts.goTrash;
  const sideRail = () => {
    const rail = screen.getAllByRole("navigation", { name: "Places" }).find((nav) => nav.matches(".oh-rail"));
    expect(rail).toBeTruthy();
    return rail!;
  };
  const entry = (rail: HTMLElement) => rail.querySelector('[data-rail-id="trash"]');
  const palette = () => screen.getByRole("listbox");
  const paletteTrash = () => within(palette()).getByRole("option", { name: new RegExp(goLabel) });
  async function openPalette() {
    press("k", { ctrlKey: true });
    await settled();
  }
  function expectNoWrite(bin: Bin) {
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
    expect(bin.replayed).toEqual([]);
    expect(takeDeleteIntents(Date.now(), "acct-1")).toEqual([]);
  }

  it("the Trash group is SPREAD AWAY off-route — no empty .rgroup may exist to differ by", async () => {
    const bin = seat({ first: "#/ohbox", folders: true, rows: [] });
    await settled();
    const off = sideRail();
    const before = off.querySelectorAll(".oh-rail-scroll [data-rail-id]").length;
    expect(off.querySelector(".oh-rail-group:empty")).toBeNull();
    expect(entry(off)).toBeNull();

    act(() => bin.address.visit("#/trash"));
    await settled();
    const on = sideRail();
    const trash = entry(on);
    expect(trash?.querySelector('[aria-current="page"]')).toBeTruthy();
    expect(trash?.querySelector(".oh-railentry-digit")).toBeNull();
    expect(on.querySelectorAll(".oh-rail-scroll [data-rail-id]")).toHaveLength(before + 1);
    fireEvent.click(within(on).getByRole("button", { name: /^Ohbox/ }));
    await settled();
    expect(bin.address.read()).toBe("#/ohbox");
    const returned = sideRail();
    expect(entry(returned)).toBeNull();
    expect(returned.querySelectorAll(".oh-rail-scroll [data-rail-id]")).toHaveLength(before);
    expect(returned.querySelector(".oh-rail-group:empty")).toBeNull();
    expectNoWrite(bin);
  });

  it("the upright rail only shows Trash while it is open", async () => {
    const bin = seat({ room: "fold", first: "#/ohbox", rows: [] });
    await settled();
    const dock = () => screen.getByRole("navigation", { name: "Places" });
    expect(dock().closest(".fr-frame")?.getAttribute("data-rail")).toBe("icons");
    expect(within(dock()).queryByRole("button", { name: T.title })).toBeNull();
    act(() => bin.address.visit("#/trash"));
    await settled();
    expect(within(dock()).getByRole("button", { name: T.title }).getAttribute("aria-current")).toBe("page");
    act(() => bin.address.visit("#/ohbox"));
    await settled();
    expect(within(dock()).queryByRole("button", { name: T.title })).toBeNull();
    expectNoWrite(bin);
  });

  const touch = (control: HTMLElement) => {
    fireEvent.pointerDown(control, { pointerType: "touch" });
    fireEvent.pointerUp(control, { pointerType: "touch" });
    fireEvent.click(control);
  };
  const footDock = () => screen.getByRole("navigation", { name: "Places" });
  const moreSheet = () => screen.getByRole("dialog", { name: "More" });

  it("phone More opens Trash by touch from Ohbox without adding a dock tab", async () => {
    const bin = seat({ room: "phone", first: "#/ohbox", rows: [] });
    await settled();
    expect(within(footDock()).queryByRole("button", { name: /^Trash/ })).toBeNull();
    const more = within(footDock()).getByRole("button", { name: "More" });
    more.focus();
    touch(more);
    await settled();
    const trash = within(moreSheet()).getByRole("button", { name: T.title });
    expect(trash).toHaveProperty("disabled", false);
    expect(trash.getAttribute("aria-current")).toBeNull();
    touch(trash);
    await settled();
    expect(bin.address.read()).toBe("#/trash");
    expect(screen.queryByRole("dialog", { name: "More" })).toBeNull();
    expect(within(footDock()).queryByRole("button", { name: /^Trash/ })).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(bin.pageRequests).toEqual([{ limit: 50 }]);
    expectNoWrite(bin);
  });

  it("phone More explains unavailable Trash and does not navigate or ask", async () => {
    const bin = seat({ room: "phone", first: "#/ohbox", rows: [], available: false });
    await settled();
    expect(table.find((binding) => binding.chord === "g t")).toMatchObject({
      disabled: true,
      disabledReason: "trash_unavailable",
    });
    const more = within(footDock()).getByRole("button", { name: "More" });
    more.focus();
    touch(more);
    await settled();
    const trash = within(moreSheet()).getByRole("button", { name: /^Trash/ });
    expect(trash).toHaveProperty("disabled", true);
    expect(trash.textContent).toContain(T.unavailable);
    expect(trash.getAttribute("aria-label")).toContain(T.unavailable);
    expect(trash.getAttribute("aria-keyshortcuts")).toBeNull();
    touch(trash);
    await settled();
    expect(bin.address.read()).toBe("#/ohbox");
    expect(moreSheet()).toBeTruthy();
    expect(bin.pageRequests).toEqual([]);
    press("Escape");
    await settled();
    expect(document.activeElement).toBe(more);

    act(() => bin.address.visit("#/trash"));
    await settled();
    expect(document.body.textContent).toContain(T.unavailable);
    expect(document.body.textContent).not.toContain(T.emptyTitle);
    expect(bin.pageRequests).toEqual([]);
    expectNoWrite(bin);
  });

  it("the entry is placed AFTER the Folders group and BEFORE the dock", async () => {
    const bin = seat({
      folders: true,
      rows: [],
      mirrored: {
        "folder:f1": { id: "f1", name: "Archive", mailboxId: "mb", mailbox: "fixture@example.invalid" },
      },
    });
    await settled();
    const rail = sideRail();
    const folders = within(rail).getByRole("button", { name: /^Folders/ });
    const lastFolder = within(rail).getByRole("button", { name: /^Archive/ });
    const trash = entry(rail)!;
    const foot = rail.querySelector(".oh-rail-foot, .fr-railfoot")!;
    expect(trash).toBeTruthy();
    expect(foot).toBeTruthy();
    expect(folders.compareDocumentPosition(lastFolder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lastFolder.compareDocumentPosition(trash) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(trash.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expectNoWrite(bin);
  });

  it("`g t` and the palette row read ONE message — the destination-row rule", async () => {
    const bin = seat({ first: "#/ohbox", rows: [], palette: true });
    await settled();
    const key = table.find((binding) => binding.chord === "g t");
    expect(key?.label).toBe(goLabel);
    await openPalette();
    const row = paletteTrash();
    expect(within(row).getByText(goLabel).textContent).toBe(key?.label);
    fireEvent.click(row);
    await settled();
    expect(bin.address.read()).toBe("#/trash");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(bin.pageRequests).toEqual([{ limit: 50 }]);
    act(() => bin.address.visit("#/ohbox"));
    await settled();
    press("g");
    press("t");
    await settled();
    expect(bin.address.read()).toBe("#/trash");
    expect(bin.pageRequests).toEqual([{ limit: 50 }, { limit: 50 }]);
    expectNoWrite(bin);
  });

  it("both are DISABLED where the client has no Trash transport, and the reason is the copy", async () => {
    const bin = seat({ first: "#/ohbox", available: false, rows: [], palette: true });
    await settled();
    expect(table.find((binding) => binding.chord === "g t")).toMatchObject({
      label: goLabel,
      disabled: true,
      disabledReason: "trash_unavailable",
    });
    press("g");
    press("t");
    await settled();
    expect(bin.address.read()).toBe("#/ohbox");
    await openPalette();
    const row = paletteTrash();
    expect(row).toHaveProperty("disabled", true);
    fireEvent.click(row);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: goLabel } });
    fireEvent.keyDown(input, { key: "Enter" });
    await settled();
    expect(paletteTrash()).toBeTruthy();
    expect(bin.address.read()).toBe("#/ohbox");
    expect(bin.pageRequests).toEqual([]);
    expectNoWrite(bin);
  });

  it("the delete keys are DISABLED in Trash and carry the no-erase sentence", async () => {
    const bin = seat();
    await settled();
    const keys = table.filter((binding) => binding.chord === "Backspace" || binding.chord === "Delete");
    expect(
      keys.map(({ chord, label, disabled, disabledReason }) => [chord, label, disabled, disabledReason]),
    ).toEqual([
      ["Backspace", searchEn.shortcuts.deleteKey, true, "no_erase"],
      ["Delete", searchEn.shortcuts.deleteKey, true, "no_erase"],
    ]);
    press("Backspace");
    press("Delete");
    await settled();
    expect(listed()).toEqual(["t1", "t2"]);
    expectNoWrite(bin);
    act(() => bin.address.visit("#/ohbox"));
    await settled();
    expect(table.some((binding) => binding.disabledReason === "no_erase")).toBe(false);
    expectNoWrite(bin);
  });

  it("`⇧⌫` restores, and only in Trash", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const bin = seat({ first: "#/ohbox", palette: true });
    await settled();
    press("Backspace", { shiftKey: true });
    await settled();
    expectNoWrite(bin);
    act(() => bin.address.visit("#/trash"));
    await settled();
    expect(bin.address.read()).toBe("#/trash/m/t1");
    await openPalette();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Backspace", shiftKey: true });
    await settled();
    expect(listed()).toEqual(["t1", "t2"]);
    expectNoWrite(bin);
    press("Escape");
    await settled();
    press("Backspace", { shiftKey: true, repeat: true });
    await settled();
    expect(listed()).toEqual(["t1", "t2"]);
    expectNoWrite(bin);
    press("Backspace", { shiftKey: true });
    await settled();
    expect(listed()).toEqual(["t2"]);
    expect(bin.restores).toEqual([]);
    await settle(UNDO_MS);
    await settled();
    expect(bin.restores).toEqual(["t1"]);
    expect(sent(bin)).toEqual([]);
    expect(bin.replayed).toEqual([]);
  });

  it("the entry's motion is ENTER ONLY, and none under reduced motion", async () => {
    const bin = seat({ first: "#/ohbox", rows: [] });
    await settled();
    const selector = '[data-rail-id="trash"] > .oh-railentry';
    expect(sideRail().querySelector(selector)).toBeNull();
    act(() => bin.address.visit("#/trash"));
    await settled();
    expect(sideRail().querySelector(selector)).toBeTruthy();

    // Bundle the registered Frame's imports in Node, outside jsdom's typed-array realm.
    const css = execFileSync(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        `require("esbuild").build({
        entryPoints: process.argv.slice(1),
        bundle: true,
        packages: "external",
        write: false,
        outdir: "out",
        logLevel: "silent",
      }).then(({ outputFiles }) => {
        for (const file of outputFiles) if (file.path.endsWith(".css")) process.stdout.write(file.text);
      });`,
        join(dirname(HERE), "../../src/frame/Frame.tsx"),
        join(dirname(HERE), "../../../tokens/src/tokens.css"),
        createRequire(import.meta.url).resolve("@ohmail/tokens/design/motion.css"),
      ],
      { encoding: "utf8" },
    );
    const root = Array.from(
      document.documentElement.attributes,
      ({ name, value }) => `${name}="${value}"`,
    ).join(" ");
    const { chromium } = createRequire(import.meta.url)(
      "@playwright/test",
    ) as typeof import("@playwright/test");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        reducedMotion: "no-preference",
      });
      await page.route("**/*", (route) => route.abort());
      await page.setContent(`<!doctype html><html ${root}><body>${sideRail().outerHTML}</body></html>`);
      await page.addStyleTag({ content: css });
      const button = page.locator(selector);
      const motion = await button.evaluate((entry) => {
        const style = getComputedStyle(entry);
        const effect = entry.getAnimations()[0]?.effect;
        const token = document.createElement("span").style;
        token.animationTimingFunction = style.getPropertyValue("--swift").trim();
        return {
          name: style.animationName,
          duration: style.animationDuration,
          fill: style.animationFillMode,
          easing: style.animationTimingFunction,
          swift: token.animationTimingFunction,
          frames:
            effect instanceof KeyframeEffect
              ? effect
                  .getKeyframes()
                  .map(({ computedOffset, opacity, translate }) => [computedOffset, opacity, translate])
              : [],
        };
      });
      expect(motion.swift).not.toBe("");
      expect(motion).toEqual({
        name: "fr-trash-in",
        duration: "0.22s",
        fill: "both",
        easing: motion.swift,
        swift: motion.swift,
        frames: [
          [0, "0", "0px 4px"],
          [1, "1", "none"],
        ],
      });
      expect(
        await button.evaluate((entry) => {
          entry.style.setProperty("--swift", "linear");
          const easing = getComputedStyle(entry).animationTimingFunction;
          entry.style.removeProperty("--swift");
          return easing;
        }),
      ).toBe("linear");

      // A host can stamp its motion fact independently of the browser's media preference.
      act(() => bin.viewport.set({ ...bin.viewport.read(), reducedMotion: true }));
      const stamp = document.documentElement.getAttribute("data-rm");
      expect(stamp).toBe("1");
      await page.evaluate((value) => document.documentElement.setAttribute("data-rm", value ?? ""), stamp);
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(false);
      expect(await button.evaluate((entry) => getComputedStyle(entry).animationDuration)).toBe("0.22s");

      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await button.evaluate((entry) => getComputedStyle(entry).animationName)).toBe("none");
      await page.evaluate(() => document.documentElement.removeAttribute("data-rm"));
      expect(await button.evaluate((entry) => getComputedStyle(entry).animationName)).toBe("none");
    } finally {
      await browser.close();
    }

    act(() => bin.address.visit("#/ohbox"));
    await settled();
    expect(sideRail().querySelector(selector)).toBeNull();
    expectNoWrite(bin);
  }, 60_000);
});

describe("the Trash view", () => {
  const bodyText = () => document.body.textContent;
  const trashRow = () => within(screen.getByRole("listbox", { name: T.title })).getByRole("option");
  const stamp = () => trashRow().querySelector("time");
  const busy = () =>
    screen.queryAllByRole("status").some((node) => node.getAttribute("aria-busy") === "true");
  function expectNoMutation(bin: Bin) {
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
    expect(bin.replayed).toEqual([]);
  }
  const gone = {
    ...trashed("t1", "ohmail/News"),
    date: "2026-01-01T00:00:00.000Z",
    trashedAt: "2026-09-09T09:00:00.000Z",
  };

  it("says TRASH IS NOT AVAILABLE HERE rather than showing an empty bin", async () => {
    const bin = seat({ rows: [], available: false });
    await settled();
    expect(bin.address.read()).toBe("#/trash");
    expect(bodyText()).toContain(T.unavailable);
    expect(bodyText()).not.toContain(T.empty);
    expect(bodyText()).not.toContain(T.emptyTitle);
    expect(busy()).toBe(false);
    expect(bin.pageRequests).toEqual([]);
    expectNoMutation(bin);
  });

  it("says nothing about emptiness until the server has answered", async () => {
    let resolve!: () => void;
    const answered = new Promise<void>((ready) => {
      resolve = ready;
    });
    const bin = seat({ rows: [], answered });
    await settled();
    expect(bodyText()).not.toContain(T.empty);
    expect(bodyText()).not.toContain(T.emptyTitle);
    expect(busy()).toBe(true);
    expect(bin.pageRequests).toEqual([{ limit: 50 }]);
    await act(async () => {
      resolve();
    });
    await settled();
    expect(bodyText()).toContain(T.emptyTitle);
    expect(busy()).toBe(false);
    expect(bin.pageRequests).toEqual([{ limit: 50 }]);
    expectNoMutation(bin);
  });

  it("says the bin is empty once the walk is exhausted", async () => {
    const bin = seat({ rows: [] });
    await settled();
    expect(bodyText()).toContain(T.emptyTitle);
    expect(bodyText()).not.toContain(T.unavailable);
    expect(busy()).toBe(false);
    expect(listed()).toEqual([]);
    expect(bin.pageRequests).toEqual([{ limit: 50 }]);
    expectNoMutation(bin);
  });

  it("the row's stamp says WHEN IT WAS DELETED, not when the message was sent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-09-09T11:00:00.000Z"));
    const bin = seat({ rows: [gone] });
    await settled();
    expect(stamp()?.textContent).toBe("Deleted 11:00");
    expect(stamp()?.textContent).not.toContain("Jan");
    expectNoMutation(bin);
  });

  it("a row with NO trashedAt shows no stamp rather than the message's own date", async () => {
    const bin = seat({ rows: [{ ...gone, trashedAt: undefined }] });
    await settled();
    expect(stamp()).toBeNull();
    expectNoMutation(bin);
  });

  it("glosses where a restore would put it, in the reader's own words", async () => {
    const bin = seat({ rows: [gone] });
    await settled();
    expect(within(trashRow()).getByText("← News")).toBeTruthy();
    expectNoMutation(bin);
  });

  it("the heading is the RAIL'S OWN WORD, so the sidebar and the pane cannot differ by one", async () => {
    const bin = seat({ rows: [] });
    await settled();
    const nav = within(screen.getByRole("navigation", { name: "Places" }));
    const rail = nav.getByRole("button", { name: /^Trash/ });
    const title = screen.getByRole("heading", { level: 1, name: T.title });
    expect(rail.textContent).toContain(title.textContent);
    expect(nav.getAllByRole("button", { name: /^Trash/ })).toEqual([rail]);
    expectNoMutation(bin);
  });
});

describe("Trash's own seat, over the mail ground", () => {
  it("lists what ohmail deleted from the engine's page, each row saying when it was deleted and where Restore puts it; the rail names Trash", async () => {
    seat();
    await settled();
    expect(listed()).toEqual(["t1", "t2"]);
    const list = screen.getByRole("listbox", { name: T.title });
    expect(list.textContent).toContain("← Ohbox");
    expect(list.textContent).toContain("← Clients");
    expect(list.textContent).toContain(T.deletedAt.replace(" {when}", ""));
    const rail = screen.getByRole("navigation", { name: "Places" });
    expect(within(rail).getByRole("button", { name: new RegExp(`^${T.title}`) })).toBeTruthy();
  });

  it("g t goes to Trash from another place: the demo's key", async () => {
    const { address } = seat({ first: "#/ohbox" });
    await settled();
    press("g");
    press("t");
    await settled();
    /* Trash, its first deleted letter standing open on arrival. */
    expect(address.read()).toBe("#/trash/m/t1");
    expect(listed()).toEqual(["t1", "t2"]);
  });

  it("two columns: Trash keeps its open letter over a walk away and back by its shortcut", async () => {
    const { address } = seat();
    await settled();
    fireEvent.click(option("t2")!);
    await settled();
    expect(address.read()).toBe("#/trash/m/t2");
    const rail = () => screen.getByRole("navigation", { name: "Places" });
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    await settled();
    expect(address.read()).toMatch(/^#\/ohbox/);
    expect(within(rail()).queryByRole("button", { name: new RegExp(`^${T.title}`) })).toBeNull();
    press("g");
    press("t");
    await settled();
    expect(address.read()).toBe("#/trash/m/t2");
    expect(within(reading()).getByRole("heading", { name: "About t2" })).toBeTruthy();
  });
});

describe("Trash's list: its first deleted letter on arrival, and its walk by key", () => {
  it("keeps the reader closed when the browser returns to a closed Trash entry", async () => {
    const bin = seat({ readerClosed: true });
    await settled();
    expect(listed()).toEqual(["t1", "t2"]);
    expect(bin.address.read()).toBe("#/trash");
  });

  /** The row the list marks as its cursor's, by the letter it carries. */
  const cursorRow = (): string | null =>
    screen.queryAllByRole("option", { selected: true }).map((r) => r.dataset.id ?? null)[0] ?? null;

  it("where two columns stand the first deleted letter stands open on arrival, so ⇧⌫ restores it at once; no other takes its place", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const bin = seat();
    await settled();
    expect(bin.address.read()).toBe("#/trash/m/t1");
    expect(within(reading()).getByRole("heading", { name: "About t1" })).toBeTruthy();
    press("Backspace", { shiftKey: true });
    await settled();
    expect(listed()).toEqual(["t2"]);
    expect(reported()).toContain(sentence(T.restoring));
    expect(bin.address.read(), "another letter took the column the restored one left").toBe("#/trash");
  });

  it("whichever read lands first, the letter standing on arrival is ohmail's first deleted one; where ohmail deleted nothing, none stands, and never one of the server's Trash", async () => {
    let answer = (): void => undefined;
    const asked: string[] = [];
    const late = seat({
      wire: serverTrash([serverRow(41, "Gone elsewhere")], asked),
      folders: true,
      answered: new Promise((done) => (answer = () => done(undefined))),
    });
    await settled();
    expect(screen.getByRole("listbox", { name: T.liveHead }).textContent).toContain("Gone elsewhere");
    expect(late.address.read(), "a letter stood open before ohmail's own page answered").toBe("#/trash");
    answer();
    await settled();
    expect(late.address.read()).toBe("#/trash/m/t1");
    expect(asked, "a letter of the server's Trash was read on arrival").toEqual(["list"]);
    cleanup();
    const none = seat({
      rows: [],
      wire: serverTrash([serverRow(41, "Gone elsewhere")], asked),
      folders: true,
    });
    await settled();
    expect(screen.getByRole("listbox", { name: T.liveHead }).textContent).toContain("Gone elsewhere");
    expect(none.address.read(), "a letter of the server's Trash stood open on arrival").toBe("#/trash");
  });

  it("a letter the address names is the one that stands; where one column stands none opens on arrival", async () => {
    const named = seat({ first: "#/trash/m/t2" });
    await settled();
    expect(named.address.read()).toBe("#/trash/m/t2");
    cleanup();
    const narrow = seat({ room: "phone" });
    await settled();
    expect(narrow.address.read()).toBe("#/trash");
    expect(screen.queryByRole("dialog", { name: "Reading" })).toBeNull();
    expect(cursorRow()).toBeNull();
  });

  it("j and ↓ open the next letter, k and ↑ the one before, the server's Trash after ohmail's own; at either end a step goes nowhere, and no step writes", async () => {
    const asked: string[] = [];
    const bin = seat({
      rows: THREE,
      wire: serverTrash([serverRow(41, "Gone elsewhere")], asked),
      folders: true,
    });
    await settled();
    expect(bin.address.read()).toBe("#/trash/m/t1");
    const went: string[] = [];
    for (const key of ["j", "ArrowDown", "j", "j", "k", "ArrowUp", "k", "k"]) {
      press(key);
      await settled();
      went.push(bin.address.read().replace("#/trash/m/", ""));
    }
    expect(went).toEqual(["t2", "t3", "mb:7:41", "mb:7:41", "t3", "t2", "t1", "t1"]);
    expect(cursorRow()).toBe("t1");
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
    expect(asked, "the server's letter was read more than once a visit").toEqual(["list", "body:41"]);
  });

  it("where one column stands j and k move the cursor's row alone, and Enter opens its letter over the list", async () => {
    const bin = seat({ room: "phone" });
    await settled();
    press("j");
    await settled();
    expect(cursorRow()).toBe("t1");
    press("j");
    await settled();
    expect(cursorRow()).toBe("t2");
    press("k");
    await settled();
    expect(cursorRow()).toBe("t1");
    expect(bin.address.read()).toBe("#/trash");
    press("Enter");
    await settled();
    expect(bin.address.read()).toBe("#/trash/m/t1");
    expect(within(reading()).getByRole("heading", { name: "About t1" })).toBeTruthy();
  });
});

function deferredRestore() {
  let resolve!: (answer: RestoreAnswer) => void;
  const promise = new Promise<RestoreAnswer>((answer) => {
    resolve = answer;
  });
  return { promise, resolve };
}

describe("the held restore", () => {
  const undo = () => screen.queryByRole("button", { name: /^Undo/ });
  const journal = () => takeDeleteIntents(Date.now(), "acct-1");
  const destination = (place: string) => sentence(T.toastRestoringTo.replace("{place}", place));
  const destinationPrefix = T.toastRestoringTo.split("{place}")[0]!;
  async function restoreShown() {
    fireEvent.click(within(panel()).getByRole("button", { name: new RegExp(T.restore) }));
    await settle();
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  it("hides the row, says Restoring…, and sends NOTHING until the window closes", async () => {
    const bin = seat();
    await settled();
    expect(listed()).toEqual(["t1", "t2"]);
    await restoreShown();
    expect(listed()).toEqual(["t2"]);
    expect(bin.address.read()).toBe("#/trash");
    expect(reported()).toContain(sentence(T.restoring));
    expect(reported()).not.toContain(destinationPrefix);
    expect(undo()).toBeTruthy();
    expect(journal().map((intent) => [intent.kind, intent.messageIds])).toEqual([["restore", ["t1"]]]);
    await settle(UNDO_MS - 1);
    expect(bin.restores).toEqual([]);
    expect(sent(bin)).toEqual([]);
    expect(reported()).not.toContain(destinationPrefix);
  });

  it("commits when the window closes, and the place is named by the SERVER's answer", async () => {
    const response = deferredRestore();
    const bin = seat({ answer: () => response.promise });
    await settled();
    expect(screen.getByRole("listbox", { name: T.title }).textContent).toContain("← Ohbox");
    await restoreShown();
    const entries = journal();
    expect(entries.map((intent) => [intent.kind, intent.messageIds])).toEqual([["restore", ["t1"]]]);
    await settle(UNDO_MS - 1);
    expect(bin.restores).toEqual([]);
    expect(reported()).not.toContain(destinationPrefix);
    await settle(1);
    expect(bin.restores).toEqual(["t1"]);
    expect(bin.intents).toEqual([entries[0]!.id]);
    expect(listed()).toEqual(["t2"]);
    expect(reported()).not.toContain(destinationPrefix);
    await act(async () => {
      response.resolve({ state: "restored", restoreTo: "ohmail/News", pending: true });
    });
    await settled();
    expect(reported()).toContain(destination("News"));
    expect(reported()).not.toContain(destination("Ohbox"));
    expect(reported()).not.toContain("Restored to News");
    expect(bin.restores).toEqual(["t1"]);
    expect(sent(bin)).toEqual([]);
    expect(listed()).toEqual(["t2"]);
  });

  it("Undo inside the window cancels a restore that never happened", async () => {
    const bin = seat();
    await settled();
    await restoreShown();
    expect(listed()).toEqual(["t2"]);
    expect(bin.restores).toEqual([]);
    expect(journal().map((intent) => intent.messageIds)).toEqual([["t1"]]);
    fireEvent.click(undo()!);
    await settled();
    expect(reported()).toContain(sentence(T.toastRestoreUndone));
    expect(listed()).toEqual(["t1", "t2"]);
    expect(journal()).toEqual([]);
    await settle(UNDO_MS + 1000);
    expect(bin.restores).toEqual([]);
    expect(sent(bin)).toEqual([]);
  });

  it("a refusal puts the row back and says the mail is still in Trash", async () => {
    const response = deferredRestore();
    const bin = seat({ answer: () => response.promise });
    await settled();
    await restoreShown();
    await settle(UNDO_MS + 1000);
    expect(bin.restores).toEqual(["t1"]);
    expect(listed()).toEqual(["t2"]);
    expect(reported()).not.toContain(sentence(T.toastRestoreFailed));
    await act(async () => {
      response.resolve({ state: "rolled_back", error: "refused", code: "provider_unreachable" });
    });
    await settled();
    expect(listed()).toEqual(["t1", "t2"]);
    expect(reported()).toContain(sentence(T.toastRestoreFailed));
    expect(reported()).not.toContain(destinationPrefix);
    expect(bin.restores).toEqual(["t1"]);
    expect(sent(bin)).toEqual([]);
  });

  it("a transport that VANISHED mid-flight reads as a refusal, never as a success", async () => {
    const response = deferredRestore();
    const bin = seat({ answer: () => response.promise });
    await settled();
    await restoreShown();
    await settle(UNDO_MS);
    expect(bin.restores).toEqual(["t1"]);
    expect(listed()).toEqual(["t2"]);
    await act(async () => {
      response.resolve({ state: "unavailable" });
    });
    await settled();
    expect(listed()).toEqual(["t1", "t2"]);
    expect(reported()).toContain(sentence(T.toastRestoreFailed));
    expect(reported()).not.toContain(destinationPrefix);
    expect(bin.restores).toEqual(["t1"]);
    expect(sent(bin)).toEqual([]);
  });

  it("a reader's press is refused WHOLE — nothing held, nothing hidden, nothing sent", async () => {
    const row = TWO[0]!;
    const organizer = "Office install";
    const since = "2026-11-10T08:00:00.000Z";
    const mailbox = {
      id: row.mailboxId,
      address: "fixture@example.invalid",
      status: "connected",
      errorCode: null,
      disabledReason: null,
      syncBlockedReason: null,
      syncBlockedSince: null,
      lastSyncAt: since,
      createdAt: since,
      organizeConsentedAt: since,
      organizerRole: "reader" as const,
      organizerState: "held" as const,
      organizedBy: { kind: "local", name: organizer, since },
    };
    const bin = seat({ rows: [row], mailboxes: async () => [mailbox] });
    await settled();
    expect(bin.address.read()).toBe("#/trash/m/t1");
    await restoreShown();
    expect(reported()).toContain(
      sentence(screenerEn.screener.readerMoveRefused.replace("{name}", organizer)),
    );
    expect(reported()).not.toContain(sentence(T.restoring));
    expect(listed()).toEqual(["t1"]);
    expect(bin.address.read()).toBe("#/trash/m/t1");
    expect(within(reading()).getByRole("heading", { name: "About t1" })).toBeTruthy();
    expect(undo()).toBeNull();
    expect(journal()).toEqual([]);
    await settle(UNDO_MS + 1000);
    expect(bin.restores).toEqual([]);
    expect(sent(bin)).toEqual([]);
  });

  it("the window duration is UNDO_MS — one number for the toast and the timer", async () => {
    const response = deferredRestore();
    const bin = seat({ answer: () => response.promise });
    await settled();
    await restoreShown();
    await settle(UNDO_MS - 1);
    const offered = undo()!;
    expect(offered).toBeTruthy();
    expect(offered.closest('[role="status"]')?.hasAttribute("data-leaving")).toBe(false);
    expect(bin.restores).toEqual([]);
    await settle(1);
    expect(bin.restores).toEqual(["t1"]);
    expect(undo()?.closest('[role="status"]')?.hasAttribute("data-leaving") ?? true).toBe(true);
    await act(async () => {
      response.resolve({ state: "restored", restoreTo: "Clients", pending: true });
    });
    await settled();
    expect(undo()).toBeNull();
    expect(bin.restores).toEqual(["t1"]);
    expect(sent(bin)).toEqual([]);
  });
});

describe("the restore's place sentence states the state it is in", () => {
  it("both catalogues say it is in progress, and neither claims it is done", () => {
    for (const [locale, words] of [
      ["en", trashEn.trash],
      ["de", trashDe.trash],
    ] as const) {
      expect(words.toastRestoringTo, locale).toContain("{place}");
      expect(words.toastRestoringTo, locale).toContain("…");
      expect(words, locale).not.toHaveProperty("toastRestored");
    }
  });
});

describe("Trash's restore", () => {
  it("the letter leaves the list at the press with its Undo and nothing is sent; when the window closes the server is asked to put it back, under the press's own id, and names where it goes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const bin = seat();
    await settled();
    fireEvent.click(option("t2")!);
    await settled();
    expect(bin.address.read()).toBe("#/trash/m/t2");
    fireEvent.click(within(panel()).getByRole("button", { name: new RegExp(T.restore) }));
    await settle();
    expect(listed(), "the restored letter is still listed").toEqual(["t1"]);
    expect(bin.address.read(), "the column kept the letter it let go").toBe("#/trash");
    expect(reported()).toContain(sentence(T.restoring));
    expect(bin.restores, "a restore left before its Undo window closed").toEqual([]);
    /* The window journals the press at once, under the press's own id, which a replay after a closed tab sends too. */
    const journaled = takeDeleteIntents(Date.now(), "acct-1");
    expect(journaled.map((i) => [i.kind, i.messageIds])).toEqual([["restore", ["t2"]]]);
    await settle(UNDO_MS + 1000);
    await settled();
    expect(bin.restores).toEqual(["t2"]);
    expect(bin.intents, "the restore went out under another id than its press's").toEqual([journaled[0]!.id]);
    /* Where it goes is the server's answer, never the row's: the row said Clients, and so did the server here. */
    expect(reported()).toContain(sentence(T.toastRestoringTo.replace("{place}", "Clients")));
    expect(listed(), "a restored letter came back into Trash").toEqual(["t1"]);
    expect(bin.mutations, "a restore wrote anything but the restore").toEqual([]);
  });

  it("⇧⌫ restores the letter that stands open, and z takes it back inside the window: the letter is back, it is said, and nothing is ever sent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const bin = seat({ first: "#/trash/m/t1" });
    await settled();
    expect(within(reading()).getByRole("heading", { name: "About t1" })).toBeTruthy();
    press("Backspace", { shiftKey: true });
    await settle();
    expect(listed()).toEqual(["t2"]);
    press("z");
    await settle();
    expect(listed()).toEqual(["t1", "t2"]);
    expect(reported()).toContain(sentence(T.toastRestoreUndone));
    await settle(UNDO_MS + 2000);
    await settled();
    expect(bin.restores, "a restore that was taken back left for the server").toEqual([]);
    expect(listed()).toEqual(["t1", "t2"]);
  });

  it("a restore the server refuses brings the letter back, said to be still in Trash", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const bin = seat({ answer: () => ({ state: "rolled_back", error: "x", code: "provider_unreachable" }) });
    await settled();
    fireEvent.click(option("t1")!);
    await settled();
    fireEvent.click(within(panel()).getByRole("button", { name: new RegExp(T.restore) }));
    await settle();
    expect(listed()).toEqual(["t2"]);
    await settle(UNDO_MS + 1000);
    await settled();
    expect(bin.restores).toEqual(["t1"]);
    expect(listed()).toEqual(["t1", "t2"]);
    expect(reported()).toContain(sentence(T.toastRestoreFailed));
  });

  it("one column: a press stands the deleted letter over the list, and its restore goes back to the list", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const bin = seat({ room: "phone" });
    await settled();
    fireEvent.click(option("t1")!);
    await settled();
    expect(bin.address.read()).toBe("#/trash/m/t1");
    expect(within(reading()).getByRole("heading", { name: "About t1" })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: new RegExp(T.restore) }));
    await settle();
    expect(bin.address.read()).toBe("#/trash");
    expect(screen.queryByRole("dialog", { name: "Reading" })).toBeNull();
    expect(listed()).toEqual(["t2"]);
    await settle(UNDO_MS + 1000);
    await settled();
    expect(bin.restores).toEqual(["t1"]);
  });
});

const unreadDeleted = (id: string): TrashRowWire => ({
  ...trashed(id, "INBOX"),
  snippet: `Deleted body for ${id}`,
  unread: true,
});

function expectPassiveTrash(bin: Bin) {
  expect(sent(bin)).toEqual([]);
  expect(bin.restores).toEqual([]);
  expect(bin.replayed).toEqual([]);
  expect(takeDeleteIntents(Date.now(), "acct-1")).toEqual([]);
  expect(reported()).toBe("");
  expect(within(panel()).getByRole("button", { name: /Mark read/ })).toBeTruthy();
}

function layOutTrashBody(id: string) {
  const reader = reading();
  const body = within(reader).getByText(`Deleted body for ${id}`);
  const scroller = readingScroller(reader)!;
  const letter = body.closest("article")!;
  const sender = letter.querySelector<HTMLElement>(".oh-messagehead-sender")!;
  expect(scroller.contains(letter)).toBe(true);
  Object.defineProperties(scroller, {
    clientHeight: { value: 240 },
    scrollHeight: { value: 480 },
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 320, 240);
  letter.getBoundingClientRect = () => new DOMRect(0, 60 - scroller.scrollTop, 320, 400);
  sender.getBoundingClientRect = () => new DOMRect(0, 60 - scroller.scrollTop, 320, 30);
  body.getBoundingClientRect = () => new DOMRect(0, 90 - scroller.scrollTop, 320, 360);
  return { body, scroller };
}

describe("the read rule in the readers off the Ohbox", () => {
  for (const width of ["wide", "narrow"] as const) {
    it(`Trash (${width}): a click, a press and a scroll read nothing and say nothing`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const bin = seat({ room: width === "wide" ? "desktop" : "phone", rows: [unreadDeleted("x1")] });
      await settled();
      fireEvent.click(option("x1")!);
      await settled();
      expect(bin.address.read()).toBe("#/trash/m/x1");
      expect(screen.queryByRole("dialog", { name: "Reading" }) !== null).toBe(width === "narrow");
      const reader = reading();
      expect(within(reader).getByRole("heading", { name: "About x1" })).toBeTruthy();
      expectPassiveTrash(bin);

      const { body, scroller } = layOutTrashBody("x1");
      scroller.focus();
      expect(document.hasFocus()).toBe(true);
      fireEvent.pointerDown(body, { pointerType: width === "wide" ? "mouse" : "touch" });
      await settle();
      expectPassiveTrash(bin);
      fireEvent.wheel(scroller, { deltaY: 30 });
      scroller.scrollTop = 30;
      fireEvent.scroll(scroller);
      expect(scroller.scrollTop).toBe(30);
      expect(body.getBoundingClientRect().top).toBe(60);
      await settle(900);
      await settled();
      expect(bin.address.read()).toBe("#/trash/m/x1");
      expectPassiveTrash(bin);
    });
  }
});

describe("a step key's landing rested on reads, off the Ohbox", () => {
  describe("CONTROLS: what reads nothing", () => {
    it("Trash: ↓ rested on reads nothing", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const bin = seat({ rows: [unreadDeleted("x1"), unreadDeleted("x2")] });
      await settled();
      const first = option("x1")!;
      fireEvent.click(first);
      await settled();
      expect(bin.address.read()).toBe("#/trash/m/x1");
      first.focus();
      press("ArrowDown");
      await settled();
      expect(bin.address.read()).toBe("#/trash/m/x2");
      expect(within(reading()).getByRole("heading", { name: "About x2" })).toBeTruthy();
      layOutTrashBody("x2");
      expect(document.hasFocus()).toBe(true);
      await settle(LANDING_REST_MS + 100);
      await settle(900);
      await settle(5000);
      await settled();
      expect(bin.address.read()).toBe("#/trash/m/x2");
      expect(option("x2")?.getAttribute("aria-selected")).toBe("true");
      expectPassiveTrash(bin);
    });
  });
});

describe("the read slot", () => {
  it("writes read state through the one seam: Mark unread on a read letter, then u marks it read again", async () => {
    const bin = seat({ first: "#/trash/m/t2" });
    await settled();
    fireEvent.click(within(panel()).getByRole("button", { name: /Mark unread/ }));
    await settled();
    expect(sent(bin)).toEqual(["mark_seen t2 unread"]);
    expect(within(panel()).getByRole("button", { name: /Mark read/ })).toBeTruthy();
    press("u");
    await settled();
    expect(sent(bin)).toEqual(["mark_seen t2 unread", "mark_seen t2 read"]);
    expect(bin.restores).toEqual([]);
  });
});

describe("the mail server's own Trash, through the seat", () => {
  it("stands where the host hands its wire and the account uses folders, read once the account's answer arrives: its rows read-only, a row's text read once on open", async () => {
    const asked: string[] = [];
    seat({ rows: [], wire: serverTrash([serverRow(41, "Gone elsewhere")], asked), folders: true });
    await settled();
    const server = screen.getByRole("listbox", { name: T.liveHead });
    expect(server.textContent).toContain("Gone elsewhere");
    expect(screen.queryByText(T.liveFailed), "the server's Trash was said unread").toBeNull();
    fireEvent.click(option("mb:7:41")!);
    await settled();
    expect(asked).toEqual(["list", "body:41"]);
    expect(reading().textContent).toContain("the text from the server");
    const own = within(reading()).getByRole("toolbar", { name: T.title });
    expect(within(own).queryAllByRole("button"), "a letter of the server's Trash offers a verb").toEqual([]);
    expect(own.textContent).toContain(T.liveReadOnly);
    expect(within(reading()).queryByRole("button", { name: new RegExp(`${T.restore}|Mark`) })).toBeNull();
  });

  it("is withheld while the account does not use folders, and where the host hands no wire: nothing is asked", async () => {
    const asked: string[] = [];
    seat({ wire: serverTrash([serverRow(41, "Gone elsewhere")], asked) });
    await settled();
    expect(listed()).toEqual(["t1", "t2"]);
    expect(screen.queryByRole("region", { name: T.liveHead })).toBeNull();
    expect(asked, "the server's Trash was read for an account that uses no folders").toEqual([]);
    cleanup();
    seat({ folders: true });
    await settled();
    expect(listed()).toEqual(["t1", "t2"]);
    expect(screen.queryByRole("region", { name: T.liveHead })).toBeNull();
  });

  it("is withheld in the demo, also where the account's folders read on and the host hands a wire: nothing is asked; the same host outside the demo reads it", async () => {
    const asked: string[] = [];
    seat({ demo: true, foldersOn: true, wire: serverTrash([serverRow(41, "Gone elsewhere")], asked) });
    await settled();
    expect(listed()).toEqual(["t1", "t2"]);
    expect(screen.queryByRole("region", { name: T.liveHead })).toBeNull();
    expect(asked, "the server's Trash was read in the demo").toEqual([]);
    cleanup();
    seat({ foldersOn: true, wire: serverTrash([serverRow(41, "Gone elsewhere")], asked) });
    await settled();
    expect(screen.getByRole("listbox", { name: T.liveHead }).textContent).toContain("Gone elsewhere");
    expect(asked).toEqual(["list"]);
  });

  it("a letter whose text could not be read is said so with a way to ask again, and the press asks once more", async () => {
    const asked: string[] = [];
    let down = true;
    const wire = serverTrash([serverRow(41, "Gone elsewhere")], asked, async () => {
      if (down) throw new Error("down");
      return { subject: "s", text: "the text from the server" };
    });
    seat({ rows: [], wire, folders: true });
    await settled();
    fireEvent.click(option("mb:7:41")!);
    await settled();
    expect(reading().textContent).toContain(T.liveBodyFailed);
    down = false;
    fireEvent.click(within(reading()).getByRole("button", { name: T.liveRetry }));
    await settled();
    expect(asked).toEqual(["list", "body:41", "body:41"]);
    expect(reading().textContent).toContain("the text from the server");
  });
});

describe("Trash keeps every letter until it is restored", () => {
  it("what Trash's live hook takes of the seam names no delete, move or raw dispatch: a line that tried one does not compile", () => {
    /* The lines stand in a file of their own (`no-erase.fixture.ts`), compiled here under the options this folder is
       checked with: the suite's runner strips types, so only the compiler says when one of them compiles. */
    const said = (d: ts.Diagnostic): string => ts.flattenDiagnosticMessageText(d.messageText, " ");
    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(dirname(HERE), "..", "..", "tsconfig.test-dirs.json"),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          throw new Error(said(d));
        },
      },
    )!;
    const program = ts.createProgram({ rootNames: [TRIED], options: parsed.options });
    const tried = program.getSourceFile(TRIED)!;
    /* The hook it read is the source this tree's suite runs, not a copy built earlier or another tree's. */
    const read = program.getSourceFiles().map((f) => f.fileName.replace(/\\/g, "/"));
    expect(read).toContain(
      join(dirname(HERE), "..", "..", "..", "app-logic", "src", "trash", "live.ts").replace(/\\/g, "/"),
    );
    const refused = [
      ...parsed.errors,
      ...program.getSyntacticDiagnostics(tried),
      ...program.getSemanticDiagnostics(tried),
    ].map(
      (d) =>
        `${d.file && d.start !== undefined ? `line ${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : "options"}: TS${d.code} ${said(d)}`,
    );
    expect(refused).toEqual([]);
  }, 60_000);

  it("⌫ and ⌦ are listed at Trash, inert, with the product's no-erase sentence as their reason", async () => {
    seat({ first: "#/trash/m/t1" });
    await settled();
    const keys = table
      .filter((b) => b.chord === "Backspace" || b.chord === "Delete")
      .map((b) => [b.chord, b.label, b.disabled === true, b.disabledReason ?? null]);
    expect(keys).toEqual([
      ["Backspace", searchEn.shortcuts.deleteKey, true, "no_erase"],
      ["Delete", searchEn.shortcuts.deleteKey, true, "no_erase"],
    ]);
  });

  it.each(["desktop", "phone"] as const)(
    "every key the place binds and every key a person reaches for to erase under every modifier, every row's own menu, a selection of several, every button and every menu row of its columns, and on a phone every row swiped (%s), over a deleted letter, a letter of the server's Trash and a row with nothing open: no step presses a delete, nothing sent is one, and no letter leaves Trash but by its restore",
    async (room) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const asked: string[] = [];
      const mountBin = async () => {
        const bin = seat({
          rows: THREE,
          room,
          wire: serverTrash([serverRow(41, "Gone elsewhere")], asked),
          folders: true,
        });
        await settled();
        expect(listed()).toEqual(["t1", "t2", "t3"]);
        return bin;
      };
      let bin = await mountBin();
      let restored = 0;
      async function finishBin() {
        await settle(UNDO_MS + 2000);
        await settled();
        expect(
          bin.mutations.filter((m) => m.kind !== "mark_seen").map((m) => m.kind),
          "a write at Trash that is not a letter's read state",
        ).toEqual([]);
        expect(bin.replayed, "a delete was sent again").toEqual([]);
        const gone = THREE.map((r) => r.id).filter((id) => !listed().includes(id));
        expect(
          gone.filter((id) => !bin.restores.includes(id)),
          "a letter left Trash by something that is not its restore",
        ).toEqual([]);
        restored += bin.restores.length;
        cleanup();
      }
      const ROWS = ["t1", "t2", "t3", "mb:7:41"];
      const walked: string[] = [];
      const stroke = (chord: string): [string, KeyboardEventInit] => {
        const parts = chord.split("+");
        return [
          parts[parts.length - 1]!,
          {
            shiftKey: parts.includes("shift"),
            ctrlKey: parts.includes("mod"),
            altKey: parts.includes("alt"),
          },
        ];
      };
      /* The keys a person reaches for to erase, each under all sixteen sets of Shift, Ctrl, Alt and Cmd (⇧⌫, Trash's
         Restore, among them); the keys that open a context menu (the menu key, and Shift with each function key); then
         the rest of what the studio's Trash refuses (b s r R F) and the keys that open and close. */
      const sets = Array.from({ length: 16 }, (_, n): KeyboardEventInit => ({
        shiftKey: (n & 1) !== 0,
        ctrlKey: (n & 2) !== 0,
        altKey: (n & 4) !== 0,
        metaKey: (n & 8) !== 0,
      }));
      const reach: [string, KeyboardEventInit][] = [
        ...["Backspace", "Delete", "d", "D", "#", "e", "a", "x", "m", "t"].flatMap((key) =>
          sets.map((set): [string, KeyboardEventInit] => [key, set]),
        ),
        ["ContextMenu", {}],
        ...Array.from({ length: 12 }, (_, n): [string, KeyboardEventInit] => [
          `F${n + 1}`,
          { shiftKey: true },
        ]),
        ...[..."bsr"].map((k): [string, KeyboardEventInit] => [k, {}]),
        ["R", { shiftKey: true }],
        ["F", { shiftKey: true }],
        ["Enter", {}],
        ["Escape", {}],
      ];
      /* Trash's own key for its read slot, then every one-key chord the key table binds at Trash (a `g` chord leaves
         for a place): the list's walk's among them. */
      const tabled = new Set<string>();
      const bound = (): [string, KeyboardEventInit][] => {
        const chords = table.map((b) => b.chord).filter((chord) => !chord.includes(" "));
        for (const chord of chords) tabled.add(chord);
        return [["u", {}], ...chords.map(stroke)];
      };
      /* Where the walk stands, and how it stands there again when a press moved it (a restore of the open letter, a
         letter closed, another place). */
      const trashOptions = () =>
        within(screen.getByRole("listbox", { name: T.title })).getAllByRole("option", { name: /\S/ });
      const standsOnClosedRow = (): boolean =>
        bin.address.read() === "#/trash" && trashOptions().some((row) => row === document.activeElement);
      const positions: { where: string; holds: () => boolean; stand: () => void | Promise<void> }[] = [
        {
          where: "a deleted letter open",
          holds: () => /^#\/trash\/m\/t\d$/.test(bin.address.read()),
          stand: () => {
            fireEvent.click(option(listed().at(-1)!)!);
          },
        },
        {
          where: "a letter of the server's Trash open",
          holds: () => bin.address.read() === "#/trash/m/mb:7:41",
          stand: () => {
            fireEvent.click(option("mb:7:41")!);
          },
        },
        {
          where: "nothing open, a row with the keyboard",
          holds: standsOnClosedRow,
          stand: async () => {
            if (bin.address.read() !== "#/trash") act(() => bin.address.visit("#/trash"));
            await settled();
            const [first] = trashOptions();
            act(() => first!.focus());
            expect(document.activeElement).toBe(first);
          },
        },
      ];
      const standAt = async (p: (typeof positions)[number]): Promise<void> => {
        if (p.holds()) return;
        if (!bin.address.read().startsWith("#/trash")) {
          act(() => bin.address.visit("#/trash"));
          await settled();
        }
        await p.stand();
        await settled();
      };
      const named = (b: HTMLElement): string => b.getAttribute("aria-label") ?? b.textContent ?? "";
      /* A key as a step names it: the modifiers held (Cmd, Ctrl, Alt, Shift) and the key, joined by `+`. */
      const chordOf = (key: string, init: KeyboardEventInit): string =>
        [init.metaKey && "Cmd", init.ctrlKey && "Ctrl", init.altKey && "Alt", init.shiftKey && "Shift", key]
          .filter((part): part is string => typeof part === "string")
          .join("+");
      /* The delete window journals a press the moment it is made, before an Undo can take it back: a step after which
         the journal holds a delete is a press that erases, even where a `z` later in the walk took it back unsent. */
      const deletesPressed: string[] = [];
      const journaled = new Set<string>();
      const step = async (what: string): Promise<void> => {
        walked.push(what);
        await settle();
        for (const intent of takeDeleteIntents(Date.now(), "acct-1")) {
          if ((intent.kind ?? "delete") !== "delete" || journaled.has(intent.id)) continue;
          journaled.add(intent.id);
          deletesPressed.push(`${what}: ${intent.messageIds.join(",")}`);
        }
      };
      for (const p of positions) {
        await standAt(p);
        /* Every row's own menu (what a right click or a menu key raises: the platform's contextmenu), and its rows. */
        for (const id of ROWS) {
          const row = option(id);
          if (row === undefined) continue;
          fireEvent.contextMenu(row);
          await step(`${p.where}: menu of ${id}`);
          for (const item of screen.queryAllByRole("menuitem")) {
            fireEvent.click(item);
            await step(`${p.where}: menu row ${named(item)} of ${id}`);
          }
          await standAt(p);
        }
        /* On a phone, each row pulled far to the left and to the right by a finger, and let go. */
        for (const id of room === "phone" ? ROWS : []) {
          for (const by of [-200, 200]) {
            const row = option(id);
            if (row === undefined) continue;
            const finger = { pointerId: 1, pointerType: "touch", clientY: 40 };
            /* A stroke the kit cannot read as a finger's fails the case instead of passing it. */
            const down = createEvent.pointerDown(row, { ...finger, clientX: 300 });
            expect((down as PointerEvent).pointerType).toBe("touch");
            expect((down as PointerEvent).clientX).toBe(300);
            fireEvent(row, down);
            fireEvent.pointerMove(row, { ...finger, clientX: 300 + by });
            fireEvent.pointerUp(row, { ...finger, clientX: 300 + by });
            await step(`${p.where}: swipe of ${id} by ${by}`);
            await standAt(p);
          }
        }
        // Restore is one of the shortcuts. Walk it after inspecting the rows, then start the next position
        // with its own Trash so an intended restore cannot remove a row from that position's coverage.
        for (const [key, init] of [...reach, ...bound()]) {
          await standAt(p);
          expect(p.holds(), p.where).toBe(true);
          press(key, init);
          await step(`${p.where}: ${chordOf(key, init)}`);
        }
        await standAt(p);
        await finishBin();
        bin = await mountBin();
      }
      /* Every button of the columns, Restore last, and every row of every menu they open: first over a selection of
         several (⇧, Ctrl and Cmd with a press), then over each letter in turn. */
      const columns = (): HTMLElement[] => [
        ...["Messages", "Reading"].flatMap((name) => screen.queryAllByRole("region", { name })),
        ...screen.queryAllByRole("dialog", { name: "Reading" }),
      ];
      const pressAll = async (over: string): Promise<void> => {
        const names = columns()
          .flatMap((c) => within(c).queryAllByRole("button"))
          .map(named)
          .sort((a, b) => Number(a.includes(T.restore)) - Number(b.includes(T.restore)));
        for (const name of names) {
          const button = columns()
            .flatMap((c) => within(c).queryAllByRole("button"))
            .find((b) => named(b) === name);
          if (button === undefined) continue;
          fireEvent.click(button);
          await step(`button ${name} over ${over}`);
          /* A press that opened a menu: each of its rows is pressed in turn. */
          for (const item of screen.queryAllByRole("menuitem")) {
            const from = bin.address.read();
            fireEvent.click(item);
            await step(`menu row ${named(item)} over ${over}`);
            if (!bin.address.read().startsWith("#/trash")) {
              act(() => bin.address.visit(from));
              await settled();
            }
          }
        }
      };
      const picks: [string, MouseEventInit][] = [
        ["t1", { shiftKey: true }],
        ["t2", { ctrlKey: true }],
        ["t3", { metaKey: true }],
      ];
      for (const [id, how] of picks) {
        const row = option(id);
        if (row === undefined) continue;
        fireEvent.click(row, how);
        await step(`picked ${id}`);
      }
      await pressAll("a selection");
      await finishBin();
      for (const id of ROWS) {
        bin = await mountBin();
        fireEvent.click(option(id)!);
        await settled();
        await pressAll(id);
        await finishBin();
      }
      /* What the walk holds: nothing it reached erased a letter. */
      expect(deletesPressed, "a step at Trash that pressed a delete").toEqual([]);
      expect(
        asked.filter((a) => a !== "list" && !a.startsWith("body:")),
        "the server's own Trash was asked something but a read",
      ).toEqual([]);
      /* And that it reached everything it names. */
      expect(walked.length, "the walk pressed next to nothing").toBeGreaterThan(80);
      expect(
        ["j", "k", "Enter", "ArrowUp", "ArrowDown"].filter((key) => !tabled.has(key)),
        "a key of the list's walk at Trash the walk never pressed",
      ).toEqual([]);
      expect(
        ROWS.filter((id) => !walked.some((w) => w.endsWith(`menu of ${id}`))),
        "a row whose own menu the walk never opened",
      ).toEqual([]);
      expect(
        walked.filter((w) => w.startsWith("picked")),
        "the walk made no selection of several",
      ).toEqual(["picked t1", "picked t2", "picked t3"]);
      expect(
        room === "phone" ? ROWS.filter((id) => !walked.some((w) => w.includes(`swipe of ${id} `))) : [],
        "a row the walk never swiped on a phone",
      ).toEqual([]);
      expect(
        walked.some((w) => w.startsWith(`button ${T.restore}`)),
        "the walk never pressed Restore",
      ).toBe(true);
      expect(
        walked.some((w) => w.startsWith("button Mark unread")),
        "the walk never pressed the read slot",
      ).toBe(true);
      expect(restored, "the walk restored nothing at all").toBeGreaterThan(0);
    },
  );
});

const PROVIDER_BOX = { id: "mb", address: "fixture@example.invalid", window: "ok" } as const;
const providerPage = (over: Partial<TrashWindowPageWire> = {}): TrashWindowPageWire => ({
  mailboxes: [PROVIDER_BOX],
  items: [],
  nextCursor: null,
  ...over,
});
const providerSection = () => screen.getByRole("region", { name: T.liveHead });
const providerHeading = () => within(providerSection()).getByRole("heading");
const providerRowIds = () =>
  within(providerSection())
    .queryAllByRole("option")
    .map((row) => row.dataset.id);

function firstPageSeat(list: TrashLiveWire["list"], rows: readonly TrashRowWire[] = []) {
  const body = vi.fn<TrashLiveWire["body"]>();
  const bin = seat({ rows, folders: true, wire: { list, body } });
  return {
    expectReadOnly() {
      expect(body).not.toHaveBeenCalled();
      expect(sent(bin)).toEqual([]);
      expect(bin.restores).toEqual([]);
    },
  };
}

describe("what the section says, decided once", () => {
  it("a read in flight is loading, and a read that FAILED is failed — never empty", async () => {
    expect(trashLiveState({ ...providerPage({ mailboxes: [] }), phase: "loading" }).state).toBe("loading");
    expect(trashLiveState({ ...providerPage(), phase: "failed" }).state).toBe("failed");

    let reject!: (error: Error) => void;
    const pending = new Promise<TrashWindowPageWire>((_resolve, fail) => {
      reject = fail;
    });
    const list = vi.fn<TrashLiveWire["list"]>().mockReturnValueOnce(pending);
    const page = firstPageSeat(list);
    await settled();
    expect(providerSection().textContent).toContain(T.liveLoading);
    expect(providerHeading().textContent).toBe(T.liveHead);
    expect(providerRowIds()).toEqual([]);
    await act(async () => {
      reject(new Error("no answer"));
    });
    await settled();
    expect(providerSection().textContent).toContain(T.liveFailed);
    expect(providerSection().textContent).not.toContain(T.liveLoading);
    expect(providerSection().textContent).not.toContain(T.liveEmpty);
    expect(providerHeading().textContent).toBe(T.liveHead);
    expect(providerRowIds()).toEqual([]);
    expect(list.mock.calls).toEqual([[]]);
    page.expectReadOnly();
  });

  it("rows are rows, whatever the per-mailbox degrades say beside them", async () => {
    const list = vi.fn<TrashLiveWire["list"]>().mockResolvedValue(
      providerPage({
        items: [serverRow(1, "Provider letter on a readable mailbox")],
        mailboxes: [PROVIDER_BOX, { ...PROVIDER_BOX, id: "other", window: "unreachable" }],
      }),
    );
    const page = firstPageSeat(list);
    await settled();
    expect(providerRowIds()).toEqual(["mb:7:1"]);
    expect(providerSection().textContent).not.toContain(T.liveReadLimited);
    expect(list.mock.calls).toEqual([[]]);
    page.expectReadOnly();
  });

  it("A MAILBOX THE SERVER COULD NOT FINISH READING outranks emptiness", async () => {
    const unreadable = { ...PROVIDER_BOX, id: "other", window: "unreachable" } as const;
    for (const mailboxes of [[unreadable], [PROVIDER_BOX, unreadable]]) {
      const list = vi.fn<TrashLiveWire["list"]>().mockResolvedValue(providerPage({ mailboxes }));
      const page = firstPageSeat(list);
      await settled();
      expect(providerSection().textContent).toContain(T.liveReadLimited);
      expect(providerSection().textContent).not.toContain(T.liveEmpty);
      expect(providerHeading().textContent).toBe(T.liveHead);
      expect(providerRowIds()).toEqual([]);
      expect(list.mock.calls).toEqual([[]]);
      page.expectReadOnly();
      cleanup();
    }
  });

  it("no folder to read is UNAVAILABLE, and so is an account this window serves none of", async () => {
    const missing = { ...PROVIDER_BOX, window: "no_trash_folder" } as const;
    for (const mailboxes of [[missing], []]) {
      const list = vi.fn<TrashLiveWire["list"]>().mockResolvedValue(providerPage({ mailboxes }));
      const page = firstPageSeat(list);
      await settled();
      expect(providerSection().textContent).toContain(T.liveUnavailable);
      expect(providerSection().textContent).not.toContain(T.liveEmpty);
      expect(providerHeading().textContent).toBe(T.liveHead);
      expect(providerRowIds()).toEqual([]);
      expect(list.mock.calls).toEqual([[]]);
      page.expectReadOnly();
      cleanup();
    }
  });

  it("a page that kept nothing but has OLDER to read claims nothing", async () => {
    const list = vi
      .fn<TrashLiveWire["list"]>()
      .mockResolvedValueOnce(
        providerPage({
          items: [{ ...serverRow(2, "Deleted in ohmail"), origin: "ohmail" }],
          nextCursor: "c1",
        }),
      )
      .mockResolvedValueOnce(providerPage({ items: [serverRow(1, "Older provider letter")] }));
    const page = firstPageSeat(list);
    await settled();
    expect(providerRowIds()).toEqual([]);
    expect(providerSection().textContent).not.toContain(T.liveEmpty);
    expect(providerHeading().textContent).toBe(T.liveHead);
    expect(list.mock.calls).toEqual([[]]);
    fireEvent.click(within(providerSection()).getByRole("button", { name: T.liveOlder }));
    await settled();
    expect(list.mock.calls).toEqual([[], [{ cursor: "c1" }]]);
    expect(providerRowIds()).toEqual(["mb:7:1"]);
    expect(within(providerSection()).queryByRole("button", { name: T.liveOlder })).toBeNull();
    page.expectReadOnly();
  });

  it("a drained walk over folders that WERE read is empty, and says so", async () => {
    const list = vi.fn<TrashLiveWire["list"]>().mockResolvedValue(providerPage());
    const page = firstPageSeat(list);
    await settled();
    expect(providerHeading().textContent).toBe(`${T.liveHead}0`);
    expect(providerSection().textContent).not.toContain(T.liveLoading);
    expect(providerSection().textContent).not.toContain(T.liveReadLimited);
    expect(providerSection().textContent).not.toContain(T.liveUnavailable);
    expect(providerRowIds()).toEqual([]);
    expect(within(providerSection()).queryByRole("button")).toBeNull();
    expect(list.mock.calls).toEqual([[]]);
    page.expectReadOnly();
  });
});

describe("the window's first page", () => {
  const go = (title: RegExp) =>
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: title }),
    );

  it("reads nothing while the view is elsewhere, and reads on arrival", async () => {
    const provider = serverTrash([serverRow(41, "Current provider letter")], []);
    const list = vi.fn(provider.list);
    const bin = seat({ first: "#/ohbox", rows: [], folders: true, wire: { ...provider, list } });
    await settled();
    expect(list).not.toHaveBeenCalled();

    press("g");
    press("t");
    await settled();
    expect(bin.address.read()).toBe("#/trash");
    expect(screen.getByRole("listbox", { name: T.liveHead }).textContent).toContain(
      "Current provider letter",
    );
    expect(list.mock.calls).toEqual([[]]);
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
  });

  it("reads once on arrival and drops ohmail's OWN deletes from the live population", async () => {
    const list = vi.fn<TrashLiveWire["list"]>().mockResolvedValue(
      providerPage({
        items: [
          serverRow(1, "First provider letter"),
          { ...serverRow(2, "About t1"), origin: "ohmail" },
          serverRow(3, "Third provider letter"),
        ],
      }),
    );
    const page = firstPageSeat(list, [TWO[0]!]);
    await settled();
    expect(list.mock.calls).toEqual([[]]);
    expect(providerRowIds()).toEqual(["mb:7:1", "mb:7:3"]);
    expect(within(providerSection()).queryByText("About t1")).toBeNull();
    expect(listed()).toEqual(["t1"]);
    expect(within(screen.getByRole("listbox", { name: T.title })).getByText("About t1")).toBeTruthy();
    page.expectReadOnly();
  });

  it("says FAILED, not empty, when the read fails — and re-asks only on the press", async () => {
    const list = vi
      .fn<TrashLiveWire["list"]>()
      .mockRejectedValueOnce(new Error("no answer"))
      .mockResolvedValueOnce(providerPage({ items: [serverRow(1, "Provider letter after retry")] }));
    const page = firstPageSeat(list);
    await settled();
    expect(providerSection().textContent).toContain(T.liveFailed);
    expect(providerSection().textContent).not.toContain(T.liveEmpty);
    expect(providerHeading().textContent).toBe(T.liveHead);
    expect(providerRowIds()).toEqual([]);
    expect(list.mock.calls).toEqual([[]]);
    await settled();
    expect(list.mock.calls).toEqual([[]]);
    fireEvent.click(within(providerSection()).getByRole("button", { name: T.liveRetry }));
    await settled();
    expect(list.mock.calls).toEqual([[], []]);
    expect(providerRowIds()).toEqual(["mb:7:1"]);
    expect(providerSection().textContent).not.toContain(T.liveFailed);
    page.expectReadOnly();
  });

  it("leaving DROPS the window, so a return reads the folder again", async () => {
    const provider = serverTrash([serverRow(41, "Old provider letter")], []);
    const first = { ...(await provider.list()), nextCursor: "previous-cursor" };
    let finish!: (page: Awaited<ReturnType<TrashLiveWire["list"]>>) => void;
    const freshPage = new Promise<Awaited<ReturnType<TrashLiveWire["list"]>>>((resolve) => {
      finish = resolve;
    });
    const list = vi.fn<TrashLiveWire["list"]>().mockResolvedValueOnce(first).mockReturnValueOnce(freshPage);
    const bin = seat({ rows: [], folders: true, wire: { ...provider, list } });
    await settled();
    expect(screen.getByRole("listbox", { name: T.liveHead }).textContent).toContain("Old provider letter");
    expect(screen.getByRole("button", { name: T.liveOlder })).toBeTruthy();

    go(/^Ohbox/);
    await settled();
    expect(screen.queryByRole("listbox", { name: T.liveHead })).toBeNull();
    expect(list.mock.calls).toEqual([[]]);

    press("g");
    press("t");
    await settled();
    expect(list.mock.calls).toEqual([[], []]);
    expect(screen.queryByText("Old provider letter")).toBeNull();
    expect(screen.queryByRole("button", { name: T.liveOlder })).toBeNull();
    await act(async () => {
      finish({ ...first, items: [serverRow(42, "Fresh provider letter")], nextCursor: null });
    });
    expect(screen.getByRole("listbox", { name: T.liveHead }).textContent).toContain("Fresh provider letter");
    expect(screen.queryByText("Old provider letter")).toBeNull();
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
  });
});

describe("show older", () => {
  async function firstProviderPage(items: readonly TrashWindowItemWire[]) {
    const provider = serverTrash(items, []);
    const first = { ...(await provider.list()), nextCursor: "c1" };
    const list = vi.fn<TrashLiveWire["list"]>().mockResolvedValueOnce(first);
    const bin = seat({ rows: [], folders: true, wire: { ...provider, list } });
    await settled();
    const rows = () =>
      within(screen.getByRole("listbox", { name: T.liveHead }))
        .getAllByRole("option")
        .map((row) => row.dataset.id);
    return { bin, first, list, rows };
  }

  it("pages with the server's cursor, appends, and never repeats a row", async () => {
    const firstRows = [serverRow(3, "Third provider letter"), serverRow(2, "Second provider letter")];
    const { bin, first, list, rows } = await firstProviderPage(firstRows);
    list.mockResolvedValueOnce({
      ...first,
      items: [firstRows[1]!, serverRow(1, "First provider letter")],
      nextCursor: null,
    });
    fireEvent.click(screen.getByRole("button", { name: T.liveOlder }));
    await settled();
    expect(list.mock.calls).toEqual([[], [{ cursor: "c1" }]]);
    expect(rows()).toEqual(["mb:7:3", "mb:7:2", "mb:7:1"]);
    expect(screen.queryByRole("button", { name: T.liveOlder })).toBeNull();
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
  });

  it("a STATED epoch reset restarts the window instead of appending under stale rows", async () => {
    const { bin, first, list, rows } = await firstProviderPage([serverRow(3, "Old provider letter")]);
    const replacement = { ...serverRow(9, "New epoch provider letter"), uidValidity: "78" };
    list.mockResolvedValueOnce({
      mailboxes: first.mailboxes.map((mailbox) => ({ ...mailbox, reset: true })),
      items: [replacement],
      nextCursor: null,
    });
    list.mockResolvedValueOnce({ ...first, items: [replacement], nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: T.liveOlder }));
    await settled();
    expect(list.mock.calls).toEqual([[], [{ cursor: "c1" }], []]);
    expect(rows()).toEqual(["mb:78:9"]);
    expect(screen.queryByText("Old provider letter")).toBeNull();
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
  });

  it("a failed older page keeps what is on screen and does not re-ask on its own", async () => {
    const { bin, list, rows } = await firstProviderPage([serverRow(3, "Kept provider letter")]);
    list.mockRejectedValueOnce(new Error("no answer"));
    fireEvent.click(screen.getByRole("button", { name: T.liveOlder }));
    await settled();
    expect(rows()).toEqual(["mb:7:3"]);
    expect((screen.getByRole("button", { name: T.liveOlder }) as HTMLButtonElement).disabled).toBe(false);
    expect(list.mock.calls).toEqual([[], [{ cursor: "c1" }]]);
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
  });
});

describe("the row key is epoch-scoped", () => {
  it("two epochs of one UID are two different rows", async () => {
    const old = { ...serverRow(9, "Previous epoch letter"), uidValidity: "77" };
    const replacement = { ...serverRow(9, "Replacement epoch letter"), uidValidity: "78" };
    expect(trashLiveKeyOf(old)).not.toBe(trashLiveKeyOf(replacement));
    const list = vi
      .fn<TrashLiveWire["list"]>()
      .mockResolvedValueOnce(providerPage({ items: [old], nextCursor: "old-epoch-cursor" }))
      .mockResolvedValueOnce(
        providerPage({
          items: [replacement],
          mailboxes: [{ ...PROVIDER_BOX, reset: true }],
        }),
      )
      .mockResolvedValueOnce(providerPage({ items: [replacement] }));
    const body = vi
      .fn<TrashLiveWire["body"]>()
      .mockResolvedValueOnce({ subject: old.subject, text: "Previous epoch body" })
      .mockResolvedValueOnce({ subject: replacement.subject, text: "Replacement epoch body" });
    const bin = seat({ rows: [], folders: true, wire: { list, body } });
    await settled();
    expect(providerRowIds()).toEqual(["mb:77:9"]);
    expect(body).not.toHaveBeenCalled();
    fireEvent.click(option("mb:77:9")!);
    await settled();
    expect(bin.address.read()).toBe("#/trash/m/mb:77:9");
    expect(reading().textContent).toContain("Previous epoch body");
    expect(body.mock.calls).toEqual([["mb", 9, "77"]]);

    fireEvent.click(within(providerSection()).getByRole("button", { name: T.liveOlder }));
    await settled();
    expect(list.mock.calls).toEqual([[], [{ cursor: "old-epoch-cursor" }], []]);
    expect(providerRowIds()).toEqual(["mb:78:9"]);
    expect(screen.queryByText(old.subject)).toBeNull();
    expect(screen.queryByText("Previous epoch body")).toBeNull();
    expect(body.mock.calls).toEqual([["mb", 9, "77"]]);
    fireEvent.click(option("mb:78:9")!);
    await settled();
    expect(bin.address.read()).toBe("#/trash/m/mb:78:9");
    expect(reading().textContent).toContain("Replacement epoch body");
    expect(reading().textContent).not.toContain("Previous epoch body");
    expect(body.mock.calls).toEqual([
      ["mb", 9, "77"],
      ["mb", 9, "78"],
    ]);
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
  });
});

describe("which verbs the reading column offers", () => {
  it("a mirrored row keeps restore and the read switch; a live row has NO action set", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const row = serverRow(41, "Provider letter");
    const list = vi.fn<TrashLiveWire["list"]>().mockResolvedValue(providerPage({ items: [row] }));
    const body = vi
      .fn<TrashLiveWire["body"]>()
      .mockResolvedValue({ subject: row.subject, text: "Provider body" });
    const bin = seat({ rows: [TWO[0]!], folders: true, wire: { list, body } });
    await settled();
    expect(listed()).toEqual(["t1"]);
    expect(within(panel()).getAllByRole("button")).toHaveLength(2);
    expect(within(panel()).getByRole("button", { name: new RegExp(T.restore) })).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: /Mark unread/ })).toBeTruthy();
    expect(body).not.toHaveBeenCalled();

    fireEvent.click(option("mb:7:41")!);
    await settled();
    const reader = within(reading());
    expect(reader.getByText("Provider body")).toBeTruthy();
    expect(reader.queryByRole("toolbar", { name: "Actions" })).toBeNull();
    const actions = within(reader.getByRole("toolbar", { name: T.title }));
    expect(actions.getByText(T.liveReadOnly)).toBeTruthy();
    expect(actions.queryAllByRole("button")).toEqual([]);
    expect(actions.queryAllByRole("link")).toEqual([]);
    expect(reader.queryByRole("button", { name: /Restore|Mark (?:un)?read/ })).toBeNull();

    fireEvent.keyDown(reading(), { key: "u" });
    fireEvent.keyDown(reading(), { key: "Backspace", shiftKey: true });
    fireEvent.keyDown(reading(), { key: "Backspace" });
    fireEvent.keyDown(reading(), { key: "Delete" });
    await settled();
    expect(takeDeleteIntents(Date.now(), "acct-1")).toEqual([]);
    await settle(UNDO_MS + 1000);
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
    expect(bin.replayed).toEqual([]);
    expect(listed()).toEqual(["t1"]);
    expect(providerRowIds()).toEqual(["mb:7:41"]);
    expect(body.mock.calls).toEqual([["mb", 41, "7"]]);

    fireEvent.click(option("t1")!);
    await settled();
    fireEvent.click(within(panel()).getByRole("button", { name: /Mark unread/ }));
    await settled();
    expect(sent(bin)).toEqual(["mark_seen t1 unread"]);
    expect(within(panel()).getByRole("button", { name: /Mark read/ })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: new RegExp(T.restore) }));
    await settle();
    expect(bin.restores).toEqual([]);
    await settle(UNDO_MS + 1000);
    await settled();
    expect(bin.restores).toEqual(["t1"]);
    expect(sent(bin)).toEqual(["mark_seen t1 unread"]);
    expect(providerRowIds()).toEqual(["mb:7:41"]);
    expect(bin.replayed).toEqual([]);
  });
});

async function providerBodySeat(
  m: TrashWindowItemWire,
  body: TrashLiveWire["body"],
  rows: readonly TrashRowWire[] = [],
) {
  const page = await serverTrash([m], []).list();
  const list = vi.fn<TrashLiveWire["list"]>().mockResolvedValue({
    ...page,
    mailboxes: page.mailboxes.map((mailbox) => ({ ...mailbox, id: m.mailboxId })),
  });
  const bin = seat({ rows, folders: true, wire: { list, body } });
  await settled();
  return bin;
}

describe("opening a row", () => {
  const row = { ...serverRow(1, "Live 1"), mailboxId: "mb1", uidValidity: "77" };
  const ask = ["mb1", 1, "77"];
  const bodyText = "the live body text";
  const readyBody = () =>
    vi.fn<TrashLiveWire["body"]>().mockResolvedValue({ subject: row.subject, text: bodyText });
  async function openLive(bin: Seated) {
    fireEvent.click(option("mb1:77:1")!);
    await settled();
    expect(bin.address.read()).toBe("#/trash/m/mb1:77:1");
  }
  function expectNoWrites(bin: Bin) {
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
    expect(bin.replayed).toEqual([]);
    expect(takeDeleteIntents(Date.now(), "acct-1")).toEqual([]);
  }

  it("a LIVE row shows its body and has ZERO actions", async () => {
    const body = readyBody();
    const bin = await providerBodySeat(row, body, [TWO[0]!]);
    expect(within(panel()).getByRole("button", { name: new RegExp(T.restore) })).toBeTruthy();
    await openLive(bin);
    const reader = within(reading());
    expect(reader.getByRole("heading", { name: row.subject })).toBeTruthy();
    expect(reader.getByText(bodyText)).toBeTruthy();
    expect(reader.getByText(row.from.name!)).toBeTruthy();
    expect(reading().querySelector(".oh-messagehead-stamp")?.getAttribute("title")).toBe(row.date);
    expect(reader.queryByRole("toolbar", { name: "Actions" })).toBeNull();
    expect(reader.queryAllByRole("button")).toEqual([]);
    expect(reader.queryAllByRole("link")).toEqual([]);
    expect(within(reader.getByRole("toolbar", { name: T.title })).getByText(T.liveReadOnly)).toBeTruthy();
    expect(body.mock.calls).toEqual([ask]);
    expectNoWrites(bin);
  });

  it("a live body that could not be read says so, with a retry and nothing else", async () => {
    const body = vi.fn<TrashLiveWire["body"]>().mockRejectedValue(new Error("not read"));
    const bin = await providerBodySeat(row, body);
    await openLive(bin);
    expect(reading().textContent).toContain(T.liveBodyFailed);
    const reader = within(reading());
    const retry = reader.getByRole("button", { name: T.liveRetry });
    expect(reader.getAllByRole("button")).toEqual([retry]);
    expect(reader.queryAllByRole("link")).toEqual([]);
    expect(reader.queryByRole("toolbar", { name: "Actions" })).toBeNull();
    expect(body.mock.calls).toEqual([ask]);
    expectNoWrites(bin);
  });

  it("a MIRRORED row keeps restore — the positive control on the same switch", async () => {
    const body = readyBody();
    const bin = await providerBodySeat(row, body, TWO);
    await openLive(bin);
    expect(within(reading()).queryByRole("toolbar", { name: "Actions" })).toBeNull();
    expect(within(reading()).getByText(bodyText)).toBeTruthy();
    fireEvent.click(option("t2")!);
    await settled();
    expect(bin.address.read()).toBe("#/trash/m/t2");
    expect(within(reading()).getByRole("heading", { name: "About t2" })).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: new RegExp(T.restore) })).toBeTruthy();
    expect(within(reading()).queryByText(bodyText)).toBeNull();
    expect(within(reading()).queryByText(T.liveReadOnly)).toBeNull();
    expect(body.mock.calls).toEqual([ask]);
    expectNoWrites(bin);
  });

  it("selecting a live row asks for its body once, through the window", async () => {
    const body = readyBody();
    const bin = await providerBodySeat(row, body);
    expect(body).not.toHaveBeenCalled();
    await openLive(bin);
    expect(body.mock.calls).toEqual([ask]);
    expect(within(reading()).getByText(bodyText)).toBeTruthy();
    expectNoWrites(bin);
  });

  it("RE-RENDERING does not re-ask, even for a body that FAILED", async () => {
    const body = readyBody().mockRejectedValueOnce(new Error("not read"));
    const bin = await providerBodySeat(row, body);
    await openLive(bin);
    expect(body.mock.calls).toEqual([ask]);
    const reader = reading();
    expect(reader.textContent).toContain(T.liveBodyFailed);
    for (const reducedMotion of [true, false]) {
      act(() => bin.viewport.set({ ...bin.viewport.read(), reducedMotion }));
      await settled();
      expect(document.documentElement.hasAttribute("data-rm")).toBe(reducedMotion);
      expect(bin.address.read()).toBe("#/trash/m/mb1:77:1");
      expect(reading()).toBe(reader);
      expect(reader.textContent).toContain(T.liveBodyFailed);
      expect(body.mock.calls).toEqual([ask]);
    }
    expectNoWrites(bin);
  });
});

describe("the body on open", () => {
  it("reads once per row per session and holds the answer", async () => {
    const row = { ...serverRow(1, "Cached provider letter"), mailboxId: "mb1", uidValidity: "77" };
    const body = vi.fn<TrashLiveWire["body"]>().mockResolvedValue({ subject: "s", text: "the body" });
    const bin = await providerBodySeat(row, body);
    expect(body).not.toHaveBeenCalled();
    fireEvent.click(option("mb1:77:1")!);
    await settled();
    expect(body.mock.calls).toEqual([["mb1", 1, "77"]]);
    expect(reading().textContent).toContain("the body");
    act(() => bin.address.visit("#/trash"));
    await settled();
    expect(bin.address.read()).toBe("#/trash");
    fireEvent.click(option("mb1:77:1")!);
    await settled();
    expect(body).toHaveBeenCalledTimes(1);
    expect(reading().textContent).toContain("the body");
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
  });

  it("a failed body is failed, and the human retry dispatches a second read", async () => {
    const row = { ...serverRow(1, "Provider retry letter"), mailboxId: "mb1", uidValidity: "77" };
    const body = vi
      .fn<TrashLiveWire["body"]>()
      .mockRejectedValueOnce(new Error("gone"))
      .mockResolvedValueOnce({ subject: "s", text: "the body" });
    const bin = await providerBodySeat(row, body);
    expect(body).not.toHaveBeenCalled();
    fireEvent.click(option("mb1:77:1")!);
    await settled();
    expect(reading().textContent).toContain(T.liveBodyFailed);
    expect(body.mock.calls).toEqual([["mb1", 1, "77"]]);
    fireEvent.click(within(reading()).getByRole("button", { name: T.liveRetry }));
    await settled();
    expect(body.mock.calls).toEqual([
      ["mb1", 1, "77"],
      ["mb1", 1, "77"],
    ]);
    expect(reading().textContent).toContain("the body");
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
  });
});

describe("the host wire — the desktop's door", () => {
  it("a HOST WIRE is a server: supported, asked, and the rows are the wire's", async () => {
    const rows = [serverRow(2, "Second provider letter"), serverRow(1, "First provider letter")];
    const asked: string[] = [];
    const bin = seat({ rows: [], folders: true, wire: serverTrash(rows, asked) });
    await settled();
    const section = screen.getByRole("listbox", { name: T.liveHead });
    expect(
      within(section)
        .getAllByRole("option")
        .map((row) => row.dataset.id),
    ).toEqual(["mb:7:2", "mb:7:1"]);
    expect(asked).toEqual(["list"]);
    expect(screen.queryByText(T.liveFailed)).toBeNull();
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
  });

  it("the six states are the SAME states over the wire — a stated absence is `unavailable` here too", async () => {
    const list = vi.fn<TrashLiveWire["list"]>().mockResolvedValue({
      mailboxes: [{ id: "mb", address: "missing@example.invalid", window: "no_trash_folder" }],
      items: [],
      nextCursor: null,
    });
    const body = vi.fn<TrashLiveWire["body"]>();
    const bin = seat({ rows: [], folders: true, wire: { list, body } });
    await settled();
    const section = screen.getByRole("region", { name: T.liveHead });
    expect(section.textContent).toContain(T.liveUnavailable);
    expect(section.textContent).not.toContain(T.liveFailed);
    expect(section.textContent).not.toContain(T.liveEmpty);
    expect(within(section).queryByRole("option")).toBeNull();
    expect(list.mock.calls).toEqual([[]]);
    expect(body).not.toHaveBeenCalled();
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
  });

  it("a wire failure is `failed`, never an empty folder — the honesty survives the substitution", async () => {
    const list = vi.fn<TrashLiveWire["list"]>().mockRejectedValue(new Error("the mail engine answered 503"));
    const body = vi.fn<TrashLiveWire["body"]>();
    const bin = seat({ rows: [], folders: true, wire: { list, body } });
    await settled();
    const section = within(screen.getByRole("region", { name: T.liveHead }));
    expect(section.getByText(T.liveFailed)).toBeTruthy();
    expect(section.getByRole("button", { name: T.liveRetry })).toBeTruthy();
    expect(section.queryByText(T.liveUnavailable)).toBeNull();
    expect(section.queryByText(T.liveEmpty)).toBeNull();
    expect(section.queryByRole("option")).toBeNull();
    expect(list.mock.calls).toEqual([[]]);
    expect(body).not.toHaveBeenCalled();
    expect(sent(bin)).toEqual([]);
    expect(bin.restores).toEqual([]);
  });

  it("the body on open goes down the WIRE, with the row's own epoch", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("unexpected network request"));
    vi.stubGlobal("fetch", fetch);
    try {
      const row = {
        ...serverRow(2, "Provider letter on the host wire"),
        mailboxId: "mb1",
        uidValidity: "77",
      };
      const body = vi.fn<TrashLiveWire["body"]>().mockResolvedValue({ subject: "s", text: "over the pipe" });
      const bin = await providerBodySeat(row, body);
      expect(body).not.toHaveBeenCalled();
      fireEvent.click(option("mb1:77:2")!);
      await settled();
      expect(body.mock.calls).toEqual([["mb1", 2, "77"]]);
      expect(reading().textContent).toContain("over the pipe");
      expect(fetch).not.toHaveBeenCalled();
      expect(sent(bin)).toEqual([]);
      expect(bin.restores).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
