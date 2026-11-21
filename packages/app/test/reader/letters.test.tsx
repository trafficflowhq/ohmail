/** @vitest-environment jsdom */
import { MailGround } from "../../src/mail/index.js";
import { FOLDERS_ON } from "../places/list-seat.js";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayAtIn, readerZone, resurfaceHorizonsIn, type PictureSeam } from "@ohmail/app-logic/reader";
import type { ReaderFile, ReaderFiles } from "../../src/reader/index.js";
import { hideMessages } from "@ohmail/app-logic/press/delete-undo";
import { presentedOver } from "@ohmail/app-logic/reading";
import type { ConsentPartition, EntityReader } from "@ohmail/client-engine";
import { markSessionAlive, markSessionDead } from "@ohmail/app-logic/session/session-truth";
import type { ReactNode } from "react";
import type { ShellDispatch } from "@ohmail/app-logic/press/shell-dispatch";
import type { ListVisit } from "@ohmail/app-logic/reading";
import { useRoomResurface, type ResurfaceTime } from "../../src/frame/room.js";
import { fakeAppearance } from "../support/fake-window.js";
import { freshRecord, letter, mountReader, READER_PLACE, WORDS } from "./support/mail.js";
import frameEn from "../../messages/frame.en.json" with { type: "json" };

/**
 * A CONVERSATION'S LETTERS, each handed to the shell's body with its own pictures, the app's scheme and the session's
 * scope; the reader draws no link of its own and opens nothing. Every host is invented.
 */

const thread = { threadId: "t1" };
/** Where a sender not let in yet waits: the Screener's folder on the mail server. */
const WAITING = "ohmail/Screener";
const LETTERS = [
  letter("m-let-in", { ...thread, date: "2026-11-10T09:00:00.000Z" }),
  letter("m-waiting", {
    ...thread,
    date: "2026-11-11T09:00:00.000Z",
    folder: "INBOX",
    physicalFolder: WAITING,
  } as never),
  letter("m-claims", {
    ...thread,
    date: "2026-11-12T09:00:00.000Z",
    senderCheck: { reason: "impersonation", brand: "Bank" },
  } as never),
];

function seam(): PictureSeam & { consents: string[] } {
  const consents: string[] = [];
  return {
    proxyFor: (id) => (url) => `/img?mid=${id}&u=${encodeURIComponent(url)}`,
    consented: () => false,
    consent: (id) => {
      consents.push(id);
    },
    auto: true,
    loadPixels: false,
    resolvedFor: () => new Map(),
    needRemote: () => {},
    consents,
  };
}

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("each letter's body", () => {
  it("is handed its own pictures: its own proxy, and the press only where its sender waits or claims a name", () => {
    const pictures = seam();
    const { handed } = mountReader({ letters: LETTERS, open: "m-claims", parts: { pictures } });
    expect([...handed.keys()].sort()).toEqual(["m-claims", "m-let-in", "m-waiting"]);
    for (const [id, props] of handed)
      expect(props.imageProxy!("https://pictures.example/a.png")).toContain(`mid=${id}&`);
    expect(handed.get("m-let-in")).toMatchObject({ remoteLoaded: true });
    expect(handed.get("m-waiting")).toMatchObject({ remoteLoaded: false });
    expect(handed.get("m-claims")).toMatchObject({ remoteLoaded: false });
    handed.get("m-waiting")!.onLoadRemote!();
    expect(pictures.consents).toEqual(["m-waiting"]);
  });

  it("with no picture door, nothing loads and nothing offers to", () => {
    const { handed } = mountReader({ letters: LETTERS, open: "m-claims" });
    for (const props of handed.values()) {
      expect(props).toMatchObject({ remoteLoaded: false, imageProxy: null, loadTrackingPixels: false });
      expect(props.onLoadRemote).toBeUndefined();
    }
  });

  it("is drawn to the app's scheme and keeps its choices under the session's scope", () => {
    const { handed } = mountReader({
      letters: [letter("m1")],
      open: "m1",
      host: { appearance: fakeAppearance({ face: "paper", scheme: "dark" }) },
    });
    expect(handed.get("m1")).toMatchObject({
      scheme: "dark",
      owner: "acct-1",
      text: "The text of m1.",
      subject: "Kiln schedule",
    });
  });

  it("says what it kept out in the head, and its own views stand above the text", () => {
    const { handed } = mountReader({ letters: [letter("m1")], open: "m1" });
    const press = vi.fn();
    const props = handed.get("m1")!;
    act(() => {
      props.onNotice({ caption: "Images blocked", text: "2 pictures were kept out." });
      props.onControls([{ id: "design", label: "Show original", onPress: press }]);
    });
    fireEvent.click(screen.getByRole("button", { name: "Show original" }));
    expect(press).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Images blocked")).toBeTruthy();
  });
});

describe("what the shell says of a letter's invitation", () => {
  const LETTERS2 = [
    letter("m1", { ...thread, date: "2026-11-10T09:00:00.000Z" }),
    letter("m2", { ...thread, date: "2026-11-11T09:00:00.000Z" }),
  ];
  function Note({ messageId }: { readonly messageId: string }) {
    return <p>{`the invitation of ${messageId}`}</p>;
  }

  it("stands over each letter's text and outside it, handed that letter's id", () => {
    mountReader({ letters: LETTERS2, open: "m2", parts: { invitation: Note } });
    const said = screen.getAllByText(/^the invitation of /).map((n) => n.textContent);
    expect(said).toEqual(["the invitation of m1", "the invitation of m2"]);
    for (const id of ["m1", "m2"]) {
      const at = document.querySelector<HTMLElement>(`[data-conv-id="${id}"]`)!;
      const note = within(at).getByText(`the invitation of ${id}`);
      const text = at.querySelector("[data-read-body]")!;
      expect(text.contains(note), "the note stands outside the letter's text").toBe(false);
      const after = note.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(after, "the text follows the note").toBeTruthy();
    }
  });

  it("where the shell says nothing of invitations, nothing stands there", () => {
    mountReader({ letters: LETTERS2, open: "m2" });
    expect(screen.queryAllByText(/^the invitation of /)).toEqual([]);
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });
});

/** A partition that holds `ids` at the gate, as the shell's consent view does for a sender nobody decided on. */
const atGate =
  (ids: readonly string[]) =>
  (raw: EntityReader): EntityReader =>
    presentedOver(
      raw,
      {
        placeOf: new Map<string, string | null>(ids.map((id) => [id, WAITING])),
        history: [],
        activity: new Map(),
        retiredDecided: new Set(),
        sentInHistory: new Set(),
        counts: {
          consentedSenders: 1,
          activeUndecidedSenders: 1,
          dormantUndecidedSenders: 0,
          historyMessages: 0,
        },
      } as unknown as ConsentPartition,
      new Set(),
      new Map(),
    );

describe("the conversation as the lists present it", () => {
  /* Ben is let in; a sender nobody decided on replies into his thread, still in INBOX on the mail server. */
  const BEN = [
    letter("a-let-in", { ...thread, date: "2026-11-10T09:00:00.000Z" }),
    letter("b-waiting", {
      ...thread,
      date: "2026-11-11T09:00:00.000Z",
      from: { name: "Stranger", address: "x@stranger.example" },
    }),
  ];

  it("a waiting sender's reply the presentation holds is in no panel of the let-in conversation", () => {
    const { handed } = mountReader({
      letters: BEN,
      open: "a-let-in",
      presented: atGate(["b-waiting"]),
      parts: { pictures: seam() },
    });
    expect([...handed.keys()]).toEqual(["a-let-in"]);
    expect(handed.get("a-let-in")).toMatchObject({ remoteLoaded: true });
  });

  it("opened at the gate, its pictures wait for the press", () => {
    const pictures = seam();
    const { handed } = mountReader({
      letters: BEN,
      open: "b-waiting",
      presented: atGate(["b-waiting"]),
      parts: { pictures },
    });
    expect(handed.get("b-waiting")).toMatchObject({ remoteLoaded: false });
    handed.get("b-waiting")!.onLoadRemote!();
    expect(pictures.consents).toEqual(["b-waiting"]);
  });

  /* The presentation holds no row of the opened letter: the column reads the raw thread, each member through it. */
  const partitionOf = (placeOf: [string, string | null][]) =>
    ({
      placeOf: new Map(placeOf),
      history: [],
      activity: new Map(),
      retiredDecided: new Set(),
      sentInHistory: new Set(),
      counts: {
        consentedSenders: 1,
        activeUndecidedSenders: 1,
        dormantUndecidedSenders: 0,
        historyMessages: 0,
      },
    }) as unknown as ConsentPartition;
  it.for([
    ["inside its own delete window", [["b-waiting", WAITING]], ["a-let-in"]],
    [
      "a History row",
      [
        ["a-let-in", null],
        ["b-waiting", WAITING],
      ],
      [],
    ],
  ] as const)(
    "opened %s, no letter of the thread loads a picture by itself: each offers the press",
    ([, places, held]) => {
      const { handed } = mountReader({
        letters: BEN,
        open: "a-let-in",
        parts: { pictures: seam() },
        presented: (raw) =>
          presentedOver(raw, partitionOf(places.map(([a, b]) => [a, b])), new Set(held), new Map()),
      });
      expect(handed.size).toBeGreaterThan(0);
      for (const [id, props] of handed) {
        expect(props.remoteLoaded, id).toBe(false);
        expect(props.onLoadRemote, id).toBeTypeOf("function");
      }
    },
  );

  it("a letter inside its delete window leaves the column", () => {
    const { handed } = mountReader({
      letters: BEN,
      open: "a-let-in",
      presented: (raw) => hideMessages(raw, new Set(["b-waiting"])),
    });
    expect([...handed.keys()]).toEqual(["a-let-in"]);
  });

  it("with no presented mirror handed, no letter loads its pictures by itself: the column is not drawn, and says why", () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pictures = seam();
    const proxy = vi.spyOn(pictures, "proxyFor");
    const load = vi.spyOn(pictures, "needRemote");
    try {
      const { handed } = mountReader({
        letters: LETTERS,
        open: "m-let-in",
        presented: null,
        parts: { pictures },
        words: { ...WORDS.en, viewError: frameEn.viewError },
      });
      const line = said.mock.calls.find(
        ([kind, place]) => kind === "[view] render failed" && place === "ohbox",
      );
      expect(line).toBeTruthy();
      expect(line[1]).toBe("ohbox");
      expect(line[2]).toBe("Error");
      /* The sentence rides only React's own report of the caught throw, never the boundary's line. */
      const error = said.mock.calls
        .filter((call: unknown[]) => call[0] !== "[view] render failed")
        .flatMap((call: unknown[]) => call)
        .find(
          (a) =>
            (a as Error | undefined)?.message ===
            "usePresented: no presented mirror stands above (PresentedMirrorContext)",
        );
      expect(error).toBeInstanceOf(Error);
      const column = within(screen.getByRole("region", { name: "Reading" }));
      expect(column.getByRole("region", { name: frameEn.viewError.title })).toBeTruthy();
      expect(column.queryByRole("article")).toBeNull();
      expect(handed.size).toBe(0);
      expect(pictures.consents).toEqual([]);
      expect(proxy).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
    } finally {
      said.mockRestore();
    }
  });
});

describe("the conversation's bodies", () => {
  it("one ask for the conversation: the opened letter urgent, its siblings in one batch, the letters none", () => {
    const four = ["a", "b", "c", "d"].map((id, i) =>
      letter(id, { ...thread, date: new Date(Date.UTC(2026, 10, 10 + i, 9)).toISOString() }),
    );
    const { mail } = mountReader({ letters: four, open: "c" });
    expect(mail.bodyAsks).toEqual(["c urgent", "thread a,b,d"]);
  });

  it("a body that failed is asked again, once, when a new session is minted", () => {
    const { mail } = mountReader({
      letters: [letter("m1", { body: undefined })],
      open: "m1",
      bodies: { m1: { state: "failed" } },
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    const before = mail.bodyAsks.length;
    act(() => markSessionAlive());
    expect(mail.bodyAsks.slice(before)).toEqual(["m1 retry"]);
  });
});

/** A file door with a ready list, recording the holds and releases of the drawn letter. */
function fileDoor(items: readonly ReaderFile[]) {
  const calls: string[] = [];
  const door: ReaderFiles = {
    hold: (id) => {
      calls.push(`hold ${id}`);
      return () => {
        calls.push(`release ${id}`);
      };
    },
    itemsOf: () => ({ state: "ready", items }),
    open: (m, a) => calls.push(`save ${m} ${a}`),
    ensure: (m, a, o) => calls.push(`ensure ${m} ${a}${o?.retry ? " retry" : ""}`),
    downloadAll: (m) => calls.push(`all ${m}`),
    downloadingAll: () => false,
    cidImagesOf: () => new Map(),
    needCidImages: () => undefined,
  };
  return { door, calls };
}
const file = (id: string, over: Partial<ReaderFile> = {}): ReaderFile => ({
  id,
  filename: `${id}.bin`,
  mimeType: "application/octet-stream",
  sizeBytes: 2048,
  state: "idle",
  inline: false,
  ...over,
});

function mountReaderFiles(options: Parameters<typeof mountReader>[0]) {
  const mounted = mountReader(options);
  // The real door notifies the mount after the hold. This fixture lacks that subscription, so re-read its answer.
  mounted.replaceEngine(mounted.mail.engine);
  return mounted;
}

describe("a letter's files", () => {
  it("the reader holds the list it draws, and lets it go once when the letter leaves", () => {
    const { door, calls } = fileDoor([
      file("plan", { filename: "plan.pdf", mimeType: "application/pdf" }),
      file("notes", { filename: "notes.txt", mimeType: "text/plain" }),
    ]);
    const looks: string[] = [];
    const { view } = mountReaderFiles({
      letters: [letter("m1")],
      open: "m1",
      parts: { files: door, look: (m, a) => looks.push(`${m} ${a}`) },
    });
    expect(screen.getByRole("button", { name: "Preview plan.pdf" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download all" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview plan.pdf" }));
    expect(looks).toEqual(["m1 plan"]);
    view.unmount();
    expect(calls.filter((c) => c.startsWith("hold") || c.startsWith("release"))).toEqual([
      "hold m1",
      "release m1",
    ]);
  });

  it("a picture drawn as a vector or a page of markup only saves, whatever its name says", () => {
    const { door, calls } = fileDoor([
      file("logo", { filename: "logo.png", mimeType: "image/svg+xml" }),
      file("page", { filename: "page.pdf", mimeType: "text/html" }),
    ]);
    const looks: string[] = [];
    mountReaderFiles({
      letters: [letter("m1")],
      open: "m1",
      parts: { files: door, look: (m, a) => looks.push(`${m} ${a}`) },
    });
    expect(screen.queryByRole("button", { name: "Preview logo.png" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Download logo.png" })[0]!);
    expect(looks).toEqual([]);
    expect(calls).toContain("save m1 logo");
  });

  it("a tile names a text's kind by its declared type: CSV for a table, TXT for plain text", () => {
    const { door } = fileDoor([
      file("table", { filename: "ledger", mimeType: "text/csv" }),
      file("note", { filename: "note.csv", mimeType: "text/plain" }),
    ]);
    mountReaderFiles({ letters: [letter("m1")], open: "m1", parts: { files: door } });
    expect(screen.getByText("CSV")).toBeTruthy();
    expect(screen.getByText("TXT")).toBeTruthy();
  });

  it("a file that did not arrive offers Try again on its tile, which asks once more", () => {
    const { door, calls } = fileDoor([
      file("big", { state: "failed", code: "unreachable", retryable: true }),
    ]);
    mountReaderFiles({ letters: [letter("m1")], open: "m1", parts: { files: door } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(calls).toContain("ensure m1 big retry");
  });
});

describe("an opened letter the mirror does not hold", () => {
  it("absent: the sheet stands with nothing said, and the letter is drawn once it arrives", () => {
    const { mail, handed } = mountReader({ letters: [], open: "m-late" });
    const pane = screen.getByRole("region", { name: "Open message" });
    expect(pane.textContent).not.toContain("moved or deleted");
    expect(screen.queryByRole("status")).toBeNull();
    act(() => mail.add(letter("m-late")));
    expect(handed.has("m-late")).toBe(true);
  });

  it("gone: only a letter the engine tombstoned is said to be moved or deleted elsewhere", () => {
    const { mail } = mountReader({ letters: [], open: "m-gone", gone: ["m-gone"] });
    expect(screen.getByText(/moved or deleted/i)).toBeTruthy();
    expect(mail.engine.messageIsGone("m-gone")).toBe(true);
  });

  it("gone: the column says it in its blank, short, with the way to Trash where the shell mounts Trash", async () => {
    const { address } = mountReader({
      letters: [],
      open: "m-gone",
      gone: ["m-gone"],
      host: {
        places: { ohbox: READER_PLACE, trash: { ...READER_PLACE, id: "trash" } },
        above: MailGround,
        wires: {
          consent: FOLDERS_ON,
          trash: {
            list: async () => ({ mailboxes: [], items: [], nextCursor: null }),
            body: async () => ({ subject: "", text: "" }),
          },
        },
      },
    });
    const pane = screen.getByRole("region", { name: "Reading" });
    expect(pane.textContent).toContain("Moved or deleted elsewhere");
    fireEvent.click(await within(pane).findByRole("button", { name: "Look in Trash" }));
    expect(address.read()).toBe("#/trash");
    cleanup();
    mountReader({ letters: [], open: "m-gone", gone: ["m-gone"] });
    expect(screen.queryByRole("button", { name: "Look in Trash" })).toBeNull();
  });
});

describe("a letter whose text is not kept here", () => {
  const kept = (withheld: string, over: Partial<Parameters<typeof letter>[1]> = {}) => ({
    letters: [letter("m1", { body: undefined, snippet: "The preview of m1", ...over } as never)],
    open: "m1",
    bodies: { m1: { state: "ready", withheld, text: "" } },
  });
  const notice = () => screen.getAllByRole("status").find((s) => s.querySelector("p"))!;

  it("emptied for space: a short title, its sentence, Load it now and Storage, a fine line; the preview first", async () => {
    const { address } = mountReader({
      ...kept("storage_cap"),
      host: {
        wires: { liveBody: () => new Promise<never>(() => undefined) } as never,
        places: { ohbox: READER_PLACE, settings: { ...READER_PLACE, id: "settings" } },
      },
    });
    const box = notice();
    expect(box.querySelector("p")!.textContent).toBe("Text on your mail server");
    expect(box.textContent).toContain("Your storage is full, so Cloud does not keep this letter's text.");
    expect(box.textContent).toContain("It loads for this view only and is not stored.");
    expect(within(box).getByRole("button", { name: "Load it now" })).toBeTruthy();
    const preview = screen.getByText("The preview of m1");
    expect(preview.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(box).getByRole("button", { name: "Storage" }));
    expect(address.read()).toBe("#/settings/storage");
  });

  it("emptied in a mailbox ohmail no longer reads: its own sentence, Storage, and nothing to load", async () => {
    mountReader({
      ...kept("storage_cap"),
      host: {
        wires: { liveBody: () => new Promise<never>(() => undefined) } as never,
        places: { ohbox: READER_PLACE, settings: { ...READER_PLACE, id: "settings" } },
        mailboxes: async () => [{ id: "mb-1", address: "me@studio.example", status: "disabled" }],
      },
    });
    await screen.findByText(/no longer reads this mailbox/);
    expect(within(notice()).queryByRole("button", { name: "Load it now" })).toBeNull();
    expect(within(notice()).getByRole("button", { name: "Storage" })).toBeTruthy();
  });

  it("a text that did not load says so, and with the session ended its way on is to sign in", () => {
    const recover = vi.fn();
    markSessionDead();
    try {
      mountReader({
        letters: [letter("m1", { body: undefined } as never)],
        open: "m1",
        bodies: { m1: { state: "failed" } },
        host: { recover },
      });
      expect(screen.getByRole("alert").textContent).toContain("Your session ended");
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      expect(recover).toHaveBeenCalledWith("signIn");
    } finally {
      markSessionAlive();
    }
  });

  it("emptied for space, where the shell mounts no Settings: no Storage", () => {
    mountReader({
      ...kept("storage_cap"),
      host: { wires: { liveBody: () => new Promise<never>(() => undefined) } as never },
    });
    expect(within(notice()).queryByRole("button", { name: "Storage" })).toBeNull();
  });

  it.for([
    ["expunged", "Gone from your mail server", {}],
    ["junk_filed", "Text in your Junk folder", { folder: "ohmail/Quarantine" }],
    ["too_large", "Larger than 64 MB", {}],
  ] as const)("%s: the title is short, and the sentence stands under it", ([withheld, title, over]) => {
    mountReader(kept(withheld, over));
    const box = notice();
    expect(box.querySelector("p")!.textContent).toBe(title);
    expect(box.querySelectorAll("p").length).toBeGreaterThan(1);
  });
});

describe("the head", () => {
  const ME = [{ id: "mb-1", address: "me@studio.example", addressIsOwn: true, status: "active" }];

  it("prints the account's own address as you, once the room has read the mailboxes", async () => {
    mountReader({ letters: [letter("m1")], open: "m1", host: { mailboxes: async () => ME } });
    expect(await screen.findByRole("button", { name: "you" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "me@studio.example" })).toBeNull();
  });

  it("stamps on the reader's calendar: the clock today, the day before it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T15:00:00.000Z"));
    try {
      const at = (iso: string) => letter(`m-${iso}`, { date: iso, threadId: null });
      mountReader({ letters: [at("2026-11-10T09:00:00.000Z")], open: "m-2026-11-10T09:00:00.000Z" });
      expect(screen.getByRole("button", { name: /^\d\d:\d\d$/ })).toBeTruthy();
      cleanup();
      mountReader({ letters: [at("2026-11-04T09:00:00.000Z")], open: "m-2026-11-04T09:00:00.000Z" });
      expect(screen.getByRole("button", { name: /^Wed 4 Nov \d\d:\d\d$/ })).toBeTruthy();
      cleanup();
      // On the upright foldable the head is narrow: the day and the month.
      mountReader({
        letters: [at("2026-11-04T09:00:00.000Z")],
        open: "m-2026-11-04T09:00:00.000Z",
        size: "fold",
      });
      expect(screen.getByRole("button", { name: "4 Nov" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  const TWO = [
    ...ME,
    {
      id: "mb-2",
      address: "mila@studio.example",
      displayName: "Studio",
      addressIsOwn: true,
      status: "active",
    },
  ];

  it("says which mailbox the letter is in, where the account has several, and nothing where it has one", async () => {
    mountReader({
      letters: [letter("m1", { mailboxId: "mb-2" })],
      open: "m1",
      host: { mailboxes: async () => TWO },
    });
    const head = screen.getByRole("heading", { name: "Kiln schedule" }).closest("header")!;
    expect(await within(head).findByText("Studio")).toBeTruthy();
    cleanup();
    mountReader({
      letters: [letter("m1", { mailboxId: "mb-1" })],
      open: "m1",
      host: { mailboxes: async () => ME },
    });
    await screen.findByRole("button", { name: "you" });
    const one = screen.getByRole("heading", { name: "Kiln schedule" }).closest("header")!;
    expect(within(one).getByRole("heading", { name: "Kiln schedule" })).toBeTruthy();
    expect(within(one).queryByText("Studio")).toBeNull();
    const subjectOnly = one.cloneNode(true) as HTMLElement;
    subjectOnly.querySelector(".oh-readinghead-short")?.remove();
    expect(subjectOnly.textContent).toBe("Kiln schedule");
  });

  it("its details name when, who, to whom with every address whole, and where it is", async () => {
    mountReader({
      letters: [
        letter("m1", {
          mailboxId: "mb-2",
          physicalFolder: "INBOX",
          cc: [{ name: "Ada Kiln", address: "ada.with.a.long.address@kiln-and-glaze.example" }],
        }),
      ],
      open: "m1",
      host: { mailboxes: async () => TWO },
    });
    await screen.findAllByText("Studio");
    fireEvent.click(screen.getByRole("button", { name: "Show the exact date and where this message sits" }));
    const terms = [...document.querySelectorAll("dt")].map((d) => d.textContent);
    expect(terms).toEqual(["Sent", "From", "To", "Cc", "In"]);
    const values = [...document.querySelectorAll("dd")].map((d) => d.textContent ?? "");
    expect(values[1]).toContain("ben@kiln.example");
    expect(values[2]).toContain("me@studio.example");
    expect(values[3]).toContain("ada.with.a.long.address@kiln-and-glaze.example");
    expect(values[4]).toBe("Ohbox · Studio");
  });

  it("the panel offers Reply all where someone besides the sender and you has the letter", () => {
    mountReader({ letters: [letter("m1")], open: "m1" });
    const panel = () => screen.getByRole("toolbar", { name: "Actions" });
    expect(within(panel()).queryByRole("button", { name: "Reply all" })).toBeNull();
    cleanup();
    mountReader({
      letters: [letter("m1", { cc: [{ name: "Ada", address: "ada@kiln.example" }] })],
      open: "m1",
    });
    expect(within(panel()).getByRole("button", { name: "Reply all" })).toBeTruthy();
    const names = within(panel())
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names.slice(0, 3)).toEqual(["Reply", "Reply all", "Forward"]);
  });

  it("one set of the account's own addresses decides Reply all: a letter to two of them alone offers none", async () => {
    const office = { id: "mb-2", address: "office@studio.example", addressIsOwn: true, status: "active" };
    const BOTH = [...ME, office];
    const to = [
      { name: null, address: "me@studio.example" },
      { name: null, address: "Office@Studio.example" },
    ];
    mountReader({ letters: [letter("m1", { to })], open: "m1", host: { mailboxes: async () => BOTH } });
    const panel = () => screen.getByRole("toolbar", { name: "Actions" });
    expect(await screen.findAllByRole("button", { name: "you" })).toHaveLength(2);
    expect(within(panel()).queryByRole("button", { name: "Reply all" })).toBeNull();
    cleanup();
    const cc = [{ name: "Ada", address: "ada@kiln.example" }];
    mountReader({ letters: [letter("m1", { to, cc })], open: "m1", host: { mailboxes: async () => BOTH } });
    expect(await screen.findAllByRole("button", { name: "you" })).toHaveLength(2);
    expect(within(panel()).getByRole("button", { name: "Reply all" })).toBeTruthy();
  });

  it("a letter's own menu answers that letter: Reply all hands write a draft, and nothing is sent", () => {
    const { mail, address } = mountReader({
      letters: [letter("m1", { cc: [{ name: "Ada", address: "ada@kiln.example" }] })],
      open: "m1",
    });
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply all" }));
    expect(address.read()).toBe("#/compose");
    expect(mail.mutations).toEqual([]);
  });

  it("a letter's own menu offers Reply all only where its audience differs from Reply's, and Mark unread only on a read letter of somebody else's", () => {
    const thread = { threadId: "t-menu" };
    mountReader({
      letters: [
        /* Unread, to the account alone: nothing to mark, nobody else to answer. */
        letter("m1", { ...thread, date: "2026-11-10T09:00:00.000Z" }),
        /* Read, and Ada has it too. */
        letter("m2", {
          ...thread,
          date: "2026-11-10T10:00:00.000Z",
          unread: false,
          cc: [{ name: "Ada", address: "ada@kiln.example" }],
        }),
        /* The account's own answer: read as every own letter is, and never to be marked unread. */
        letter("m3", { ...thread, date: "2026-11-10T11:00:00.000Z", unread: false, local: true }),
      ],
      open: "m2",
    });
    const offered = (at: number): string[] => {
      fireEvent.click(within(screen.getAllByRole("article")[at]!).getByRole("button", { name: "Message" }));
      const names = screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      return names;
    };
    expect(offered(0), "unread, to the account alone").toEqual(["Reply", "Forward"]);
    expect(offered(1), "read, with Ada on it").toEqual(["Reply", "Reply all", "Forward", "Mark unread"]);
    expect(offered(2), "the account's own letter").not.toContain("Mark unread");
  });

  it("on a phone the way back names the place it goes back to, and goes there", () => {
    const { address } = mountReader({ letters: [letter("m1")], open: "m1", size: "phone" });
    const pane = screen.getByRole("region", { name: "Open message" });
    fireEvent.click(within(pane).getByRole("button", { name: "Ohbox" }));
    expect(address.read()).toBe("#/ohbox");
  });

  it("a single letter's head names no faces; its tags stand whole", () => {
    mountReader({
      letters: [letter("m1", { labels: ["t-studio"] })],
      open: "m1",
      rows: { "tag:t-studio": { id: "t-studio", name: "Studio", hue: "moss" } },
    });
    const head = screen.getByRole("heading", { name: "Kiln schedule" }).closest("header")!;
    expect(within(head).getByText("Studio")).toBeTruthy();
    expect(head.textContent).not.toContain("Ben Kiln");
  });

  const MILA = { name: "Mila Brunner", address: "me@studio.example" };
  const GIULIA = { name: "Giulia Ferrari", address: "giulia@terracotta.example" };
  const BEN = { name: "Ben Arnold", address: "ben@terracotta.example" };

  it("names who is in the conversation, oldest voice first; the account's own is not one of them", async () => {
    const t1 = { threadId: "t1" };
    mountReader({
      letters: [
        letter("c1", { ...t1, date: "2026-11-05T15:20:00.000Z", from: MILA, to: [GIULIA] }),
        letter("c2", { ...t1, date: "2026-11-06T08:05:00.000Z", from: GIULIA }),
        letter("c3", { ...t1, date: "2026-11-09T16:30:00.000Z", from: BEN }),
        letter("c4", { ...t1, date: "2026-11-10T08:12:00.000Z", from: GIULIA }),
      ],
      open: "c4",
      host: { mailboxes: async () => ME },
    });
    const head = screen.getByRole("heading", { level: 2 }).closest("header")!;
    expect(await within(head).findByText("Giulia Ferrari, Ben Arnold")).toBeTruthy();
    expect(head.textContent).not.toContain("Mila Brunner");
  });

  it("names a conversation by its own subject, the one its thread carries; a single letter by its own", () => {
    const t1 = { threadId: "t1" };
    const glaze = [
      letter("g1", { ...t1, subject: "Glaze order #2291", date: "2026-11-05T15:20:00.000Z" }),
      letter("g2", { ...t1, subject: "Re: Glaze order #2291", date: "2026-11-10T08:12:00.000Z" }),
    ];
    mountReader({
      letters: glaze,
      open: "g2",
      rows: { "thread:t1": { id: "t1", subject: "Glaze order #2291" } },
    });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Glaze order #2291");
    cleanup();
    // Before its thread has synced, the opened letter's own.
    mountReader({ letters: glaze, open: "g2" });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Re: Glaze order #2291");
    cleanup();
    mountReader({
      letters: [letter("s1", { threadId: "t2", subject: "Re: Kiln schedule" })],
      open: "s1",
      rows: { "thread:t2": { id: "t2", subject: "Kiln schedule" } },
    });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Re: Kiln schedule");
  });

  it("prints You for the sender of a letter of the account's own, once the room has read the mailboxes", async () => {
    mountReader({
      letters: [letter("y1", { from: MILA, to: [{ name: "Ben Kiln", address: "ben@kiln.example" }] })],
      open: "y1",
      host: { mailboxes: async () => ME },
    });
    expect(await screen.findByRole("button", { name: /You\s*me@studio\.example$/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mila Brunner/ })).toBeNull();
  });

  it("the recipients' line says to and cc as the head says them", async () => {
    mountReader({
      letters: [letter("k1", { cc: [{ name: "Ada Kiln", address: "ada@kiln.example" }] })],
      open: "k1",
      host: { mailboxes: async () => ME },
    });
    await screen.findByRole("button", { name: "you" });
    const line = screen.getByRole("button", { name: "Ada Kiln" }).closest("p")!;
    expect(line.textContent).toBe("to you · cc Ada Kiln details");
  });

  it("Later, Park and Resurface are toggles that say whether the letter is filed there", () => {
    const filed = (state: "reply_later" | "set_aside" | "bubbled_up" | null) =>
      letter("f1", {
        triage:
          state === null
            ? null
            : {
                messageId: "f1",
                state,
                bubbleUpAt: state === "bubbled_up" ? "2026-11-13T08:00:00.000Z" : null,
                setAt: "2026-11-10T09:00:00.000Z",
                updatedAt: "2026-11-10T09:00:00.000Z",
              },
      });
    const pressed = () => {
      const panel = screen.getByRole("toolbar", { name: "Actions" });
      return ["Later", "Park", "Resurface"].map((name) =>
        within(panel).getByRole("button", { name }).getAttribute("aria-pressed"),
      );
    };
    for (const [state, held] of [
      ["reply_later", ["true", "false", "false"]],
      ["set_aside", ["false", "true", "false"]],
      ["bubbled_up", ["false", "false", "true"]],
      [null, ["false", "false", "false"]],
    ] as const) {
      mountReader({ letters: [filed(state)], open: "f1" });
      expect(pressed(), String(state)).toEqual(held);
      cleanup();
    }
  });
});

describe("a letter the account sent", () => {
  const SAID =
    "The copy for your Sent folder could not be saved. The message went out; nothing to send again.";
  const t1 = { threadId: "t1" };
  const SENT = [
    letter("s1", { ...t1, date: "2026-11-09T10:00:00.000Z" }),
    letter("s2", {
      ...t1,
      date: "2026-11-10T10:00:00.000Z",
      from: { name: "Mila Brunner", address: "me@studio.example" },
      to: [{ name: "Ben Kiln", address: "ben@kiln.example" }],
    }),
  ];

  it("carries what the shell says of its copy in Sent as a note under its recipients; the others carry none", () => {
    mountReader({
      letters: SENT,
      open: "s2",
      parts: { sentCopy: (id: string) => (id === "s2" ? SAID : null) },
    });
    const notes = screen.getAllByRole("note");
    expect(notes.map((n) => n.textContent)).toEqual([SAID]);
    expect(notes[0]!.closest("[data-conv-id]")!.getAttribute("data-conv-id")).toBe("s2");
    cleanup();
    mountReader({ letters: SENT, open: "s2", parts: { sentCopy: "none" } });
    expect(screen.queryAllByRole("note")).toEqual([]);
  });
});

describe("the panel's menus", () => {
  it("Resurface offers its days and files the letter at the one chosen", async () => {
    const { mail } = mountReader({ letters: [letter("m1")], open: "m1" });
    fireEvent.click(screen.getByRole("button", { name: "Resurface" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /^Tomorrow/ }));
    });
    expect(mail.mutations).toEqual([
      expect.objectContaining({ kind: "triage_set", messageId: "m1", state: "bubbled_up" }),
    ]);
  });

  describe("Resurface: when", () => {
    /* Tuesday 10 November 2026, mid-afternoon wherever the suite runs. */
    const NOW = new Date("2026-11-10T15:00:00.000Z");
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());
    const zone = readerZone();
    const booked = (mail: { mutations: unknown[] }) =>
      (mail.mutations as { bubbleUpAt?: string }[]).map((m) => m.bubbleUpAt);
    const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Resurface" }));

    it("names the time before any choice, the product's 09:00, and Tomorrow books it in the reader's zone", async () => {
      const { mail } = mountReader({ letters: [letter("m1")], open: "m1" });
      openMenu();
      expect((screen.getByLabelText("Time", { selector: "input" }) as HTMLInputElement).value).toBe("09:00");
      const tomorrow = resurfaceHorizonsIn(NOW, "09:00", zone).tomorrow;
      const item = screen.getByRole("menuitem", { name: /^Tomorrow/ });
      expect(item.textContent).toContain(tomorrow.time);
      expect(screen.getByRole("menuitem", { name: /^Now$/ })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: /^Next week/ })).toBeTruthy();
      await act(async () => {
        fireEvent.click(item);
      });
      expect(booked(mail)).toEqual([tomorrow.iso]);
    });

    it("a time typed in the field is the hour every day books", async () => {
      const { mail } = mountReader({ letters: [letter("m1")], open: "m1" });
      openMenu();
      fireEvent.change(screen.getByLabelText("Time", { selector: "input" }), { target: { value: "14:30" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: /^Next week/ }));
      });
      const week = resurfaceHorizonsIn(NOW, "14:30", zone).nextWeek!;
      expect(booked(mail)).toEqual([week.iso]);
      expect(week.time).toBe("14:30");
    });

    it("Now is a state, not a date", async () => {
      const { mail } = mountReader({ letters: [letter("m1")], open: "m1" });
      openMenu();
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: /^Now$/ }));
      });
      expect(mail.mutations).toEqual([
        expect.objectContaining({ kind: "triage_set", messageId: "m1", state: "resurfaced" }),
      ]);
    });

    it("Pick a date: a day already past books nothing, a later one books that day at the time, Back returns", async () => {
      const { mail } = mountReader({ letters: [letter("m1")], open: "m1" });
      openMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Pick a date" }));
      expect(screen.queryByRole("menuitem", { name: /^Tomorrow/ })).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Mon 9 Nov 2026/ }));
      });
      expect(mail.mutations).toEqual([]);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Fri 20 Nov 2026, 09:00" }));
      });
      expect(booked(mail)).toEqual([dayAtIn("2026-11-20", "09:00", zone).iso]);
      openMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Pick a date" }));
      fireEvent.click(screen.getByRole("button", { name: "Next month" }));
      expect(screen.getByRole("button", { name: /^Tue 1 Dec 2026/ })).toBeTruthy();
      fireEvent.click(screen.getByRole("menuitem", { name: "Back" }));
      expect(screen.getByLabelText("Time", { selector: "input" })).toBeTruthy();
    });

    it("on a Sunday Next week is Tomorrow's Monday, so it is not offered", () => {
      vi.setSystemTime(new Date("2026-11-15T12:00:00.000Z"));
      mountReader({ letters: [letter("m1")], open: "m1" });
      openMenu();
      expect(screen.getByRole("menuitem", { name: /^Tomorrow/ })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: /^Next week/ })).toBeNull();
    });

    describe("the account's hour, as a part above the panes hands it to the room", () => {
      /** What the list's path heard, and what was kept, in the order it happened. */
      const heard: string[] = [];
      beforeEach(() => {
        heard.length = 0;
      });
      const store = vi.fn(async (hhmm: string) => void heard.push(`kept ${hhmm}`));
      function handing(resurface: ResurfaceTime) {
        /* A part above the panes hands the room's own seam the account's hour, as the mail ground does; the list's
           visit runs the verbs. */
        function Shell({ children }: { children: ReactNode }) {
          useRoomResurface(resurface);
          return <>{children}</>;
        }
        const visit: ListVisit = {
          openId: "m1",
          unread: false,
          readSet: [],
          act: (action) => void heard.push(String(action)),
          wiring: {
            look: "tint",
            record: freshRecord(),
            onRead: vi.fn(),
            onEnter: vi.fn(),
            onMarkUnread: vi.fn(),
          },
          step: {
            up: { disabled: true, run: vi.fn(), label: "Previous message" },
            down: { disabled: true, run: vi.fn(), label: "Next message" },
          },
        };
        const meeting = { visit, blank: null };
        mountReader({ letters: [letter("m1")], open: "m1", meeting, host: { above: Shell } });
      }
      const time = () => screen.getByLabelText("Time", { selector: "input" }) as HTMLInputElement;
      const press = async (name: RegExp) => {
        await act(async () => {
          fireEvent.click(screen.getByRole("menuitem", { name }));
        });
      };

      it("offers the stored hour; a changed one is kept once, after the letter is booked", async () => {
        store.mockClear();
        handing({ stored: "07:30", store });
        openMenu();
        expect(time().value).toBe("07:30");
        fireEvent.change(time(), { target: { value: "10:15" } });
        await press(/^Tomorrow/);
        const tomorrow = resurfaceHorizonsIn(NOW, "10:15", zone).tomorrow;
        expect(heard).toEqual([`resurface:${tomorrow.iso}`, "kept 10:15"]);
        expect(store).toHaveBeenCalledTimes(1);
      });

      it("an hour left as stored is no decision, and Now keeps nothing", async () => {
        store.mockClear();
        handing({ stored: "07:30", store });
        openMenu();
        await press(/^Next week/);
        openMenu();
        fireEvent.change(time(), { target: { value: "10:15" } });
        await press(/^Now$/);
        const week = resurfaceHorizonsIn(NOW, "07:30", zone).nextWeek!;
        expect(heard).toEqual([`resurface:${week.iso}`, "resurface_now"]);
        expect(store).not.toHaveBeenCalled();
      });

      it("where nothing can be kept, the product's 09:00 is offered and a changed hour books, kept nowhere", async () => {
        handing({ stored: null, store: null });
        openMenu();
        expect(time().value).toBe("09:00");
        fireEvent.change(time(), { target: { value: "10:15" } });
        await press(/^Tomorrow/);
        expect(heard).toEqual([`resurface:${resurfaceHorizonsIn(NOW, "10:15", zone).tomorrow.iso}`]);
      });
    });
  });

  it("Tag lists the account's tags with the letter's own checked, and a press puts one on", async () => {
    const { mail } = mountReader({
      letters: [letter("m1", { labels: ["t-studio"] })],
      open: "m1",
      rows: {
        "tag:t-studio": { id: "t-studio", name: "Studio", hue: "moss" },
        "tag:t-kiln": { id: "t-kiln", name: "Kiln", hue: "clay" },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Tag" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Studio" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Kiln" }));
    });
    expect(mail.mutations).toEqual([
      { kind: "tag_assign", messageId: "m1", tagId: "t-kiln", assigned: true },
    ]);
  });

  describe("what does not fit the panel", () => {
    function expectMenuOrder(labels: readonly string[]) {
      const menu = within(screen.getByRole("menu", { name: "More" }));
      expect(menu.getAllByRole("menuitem")).toEqual(
        labels.map((name) => menu.getByRole("menuitem", { name, exact: true })),
      );
    }

    /* jsdom lays nothing out: the panel's bar is as wide as its shown verbs, 100 each, in a room of 350. */
    const shownVerbs = (el: Element) =>
      [...el.querySelectorAll<HTMLElement>("[data-rank]")].filter((v) => !v.hidden).length;
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("role") === "toolbar" ? shownVerbs(this) * 100 : 0;
      });
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("oh-actionpanel") ? 350 : 0;
      });
    });
    afterEach(() => vi.restoreAllMocks());

    it("stands behind More, first and in the panel's order, and runs from there", async () => {
      const { mail } = mountReader({
        letters: [letter("m1")],
        open: "m1",
        rows: { "tag:t-kiln": { id: "t-kiln", name: "Kiln", hue: "clay" } },
      });
      const panel = screen.getByRole("toolbar", { name: "Actions" });
      expect(within(panel).queryByRole("button", { name: "Park" })).toBeNull();
      fireEvent.click(within(panel).getByRole("button", { name: "More" }));
      expectMenuOrder(["Later", "Park", "Resurface", "Tag", "Delete"]);
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Park" }));
      });
      expect(mail.mutations).toEqual([{ kind: "triage_set", messageId: "m1", state: "set_aside" }]);
      fireEvent.click(within(panel).getByRole("button", { name: "More" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Tag" }));
      expect(screen.getByRole("menuitemcheckbox", { name: "Kiln" })).toBeTruthy();
    });

    /* The design's order (the simulator's panel): Reply, Forward and the read slot never fold; on the upright
       foldable the read slot gives up its word first and Reply all and Tag stand behind More; on a phone the read
       slot stands there too. */
    it.for([
      [
        "fold",
        ["Reply", "Forward", "Mark unread"],
        ["Mark unread"],
        ["Reply all", "Later", "Park", "Resurface", "Tag", "Delete"],
      ],
      [
        "phone",
        ["Reply", "Forward", "Later"],
        [],
        ["Reply all", "Park", "Resurface", "Tag", "Mark unread", "Delete"],
      ],
    ] as const)(
      "on the %s, the panel and More stand in the design's order",
      ([size, panelIs, iconOnly, moreIs]) => {
        mountReader({
          /* Read already, so the read slot says Mark unread; it went to two more people, so Reply all stands. */
          letters: [
            letter("m1", {
              unread: false,
              cc: [
                { name: "Jonas", address: "jonas@lichtgrat.example" },
                { name: "Nadja", address: "nadja@erdton-atelier.example" },
              ],
            }),
          ],
          open: "m1",
          size,
          rows: { "tag:t-kiln": { id: "t-kiln", name: "Kiln", hue: "clay" } },
        });
        const panel = screen.getByRole("toolbar", { name: "Actions" });
        const standing = within(panel)
          .getAllByRole("button")
          .filter((b) => !b.hidden && b.getAttribute("aria-label") !== "More");
        expect(standing.map((b) => b.getAttribute("aria-label"))).toEqual([...panelIs]);
        /* A verb that gave up its word is marked so by the kit's fit; nothing else gave it up. */
        expect(
          standing.filter((b) => b.dataset.short !== undefined).map((b) => b.getAttribute("aria-label")),
        ).toEqual([...iconOnly]);
        fireEvent.click(within(panel).getByRole("button", { name: "More" }));
        expectMenuOrder([...moreIs]);
      },
    );
  });
});

describe("links", () => {
  it("the reader's own nodes carry no address, and nothing opens on mount, focus or a key's travel", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    mountReader({ letters: LETTERS, open: "m-claims" });
    const pane = screen.getByRole("region", { name: "Open message" });
    expect(pane.querySelectorAll("a[href]")).toHaveLength(0);
    for (const button of within(pane).getAllByRole("button")) fireEvent.focus(button);
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});

describe("in German", () => {
  it("every word of the column is German and no key shows", () => {
    mountReader({ letters: LETTERS, open: "m-claims", lang: "de" });
    const pane = screen.getByRole("region", { name: "Geöffnete Nachricht" });
    for (const name of ["Antworten", "Weiterleiten", "Später", "Parken", "Als gelesen markieren", "Mehr"]) {
      expect(within(pane).getByRole("button", { name })).toBeTruthy();
    }
    expect(pane.textContent).not.toMatch(/\b(?:verb|reader|message|toast)\.[a-zA-Z]/);
  });
});
