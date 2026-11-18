/** @vitest-environment jsdom */
/**
 * THE MAIL GROUND UNDER THE FRAME. A host hands `MailGround` as what it stands above every pane. The ground brings
 * no press seam: the frame's room mounts its own, once, for the frame's life, whatever place is on screen. So a walk
 * between places of other bodies ends no undo window, the delete journal a closed tab left is replayed once, and a
 * press at any place leaves through the one seam.
 *
 * The seam is the real `useShellDispatch`, counted live through a wrapper.
 *
 * And what the ground itself stands: the mail state, the consent row, the partition and the presented mirror, each
 * mounted once per frame under the frame's scope and read by a place through its reader. Under a scope the frame
 * refuses, nothing of it is mounted and no wire is asked; one account's remembered answer is never read under
 * another; over a host with no consent wire pictures stay on the per-letter press; and a reader outside its provider
 * throws its own sentence, never an empty answer.
 *
 * And the two doors of a letter, mounted by the ground: over a host that names no picture wire no picture door
 * stands; over one that does, no letter loads a picture by itself before the consent row's live answer; over an
 * engine that opens no file no file door stands. The pixel switch the ground hands the picture door is the row's own,
 * and a picture's address is minted only while the window may read for its engine's account. A press of Show images
 * made under one scope is never read under another.
 */
import type { EngineMessage } from "@ohmail/wire";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Component, Profiler, useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConsent, usePartition } from "@ohmail/app-logic/consent";
import { CONSENT_BOOT_SCOPE } from "@ohmail/app-logic/consent/consent-state";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { letterPictures, useDoors } from "@ohmail/app-logic/reader";
import { armDeleteIntent } from "@ohmail/app-logic/press/delete-intents";
import type { ShellDispatchInput } from "@ohmail/app-logic/press/shell-dispatch";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import { usePresented, usePresentedMirror } from "@ohmail/app-logic/reading";
import { bootCacheKey } from "@ohmail/app-logic/session/boot-cache";
import {
  createSyncGate,
  registerSyncGate,
  type SyncGate,
  type SyncIdentity,
} from "@ohmail/app-logic/session/sync-scheduler";
import type { FramePlaces, PlaceEntry } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { usePress, useRoomHolds } from "../../src/frame/room.js";
import {
  NONE,
  type ConsentWire,
  type HostReads,
  type ImageWire,
  type None,
  type ReaderEntry,
} from "../../src/host/index.js";
import { ConsentMount, DoorsMount, MailStateMount, PresentedMount } from "../../src/mail/ground/index.js";
import { MailGround } from "../../src/mail/index.js";
import { TextProvider } from "../../src/text/index.js";
import { KeymapProvider } from "../../src/keys/index.js";
import { fakeMail, letter, WORDS, type FakeMail } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, type FakeAddress } from "../support/fake-window.js";

/** How often the press seam was mounted, and how many stand now. */
const seam = vi.hoisted(() => ({ mounts: 0, live: 0 }));
vi.mock("@ohmail/app-logic/press/shell-dispatch", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/press/shell-dispatch")>();
  const { useEffect: effect } = await import("react");
  return {
    ...real,
    useShellDispatch: (input: ShellDispatchInput) => {
      const made = real.useShellDispatch(input);
      effect(() => {
        seam.mounts += 1;
        seam.live += 1;
        return () => {
          seam.live -= 1;
        };
      }, []);
      return made;
    },
  };
});

const SCOPE = "acct-1";
const READER: ReaderEntry = { Reading: () => <p>the reading column</p>, Actions: () => null };

/** Three places of three bodies that draw nothing of the seam. */
const QUIET: Partial<FramePlaces> = {
  ohbox: {
    id: "ohbox",
    body: "ohbox",
    rail: null,
    panes: { kind: "columns", List: () => <p>the Ohbox</p>, Reading: "reader" },
  },
  news: { id: "news", body: "news", rail: null, panes: { kind: "wide", Wide: () => <p>News</p> } },
  search: { id: "search", body: "search", rail: null, panes: { kind: "wide", Wide: () => <p>Search</p> } },
};

/** The seams the pressing places met, each named by an object it keeps for its life. */
const met: unknown[] = [];
/** What a place draws of the frame's seam, as a seat reads it: what the room holds back, and a press through it. */
function Pressing({ at }: { at: string }) {
  const press = usePress();
  const { held } = useRoomHolds();
  useEffect(() => {
    met.push(press.undoLink);
  }, [press]);
  return (
    <div>
      <p>{`${at}: held ${[...held].join(",") || "none"}`}</p>
      <button type="button" onClick={() => press.deleting.remove({ id: "m1", mailboxId: "mb-1" })}>
        Delete m1
      </button>
    </div>
  );
}
const pressing = (id: PlaceEntry["id"], panes: PlaceEntry["panes"]): PlaceEntry => ({
  id,
  body: id,
  rail: null,
  panes,
});
/** The same three places, each pressing through the frame's seam. */
const PRESSING: Partial<FramePlaces> = {
  ohbox: pressing("ohbox", { kind: "columns", List: () => <Pressing at="the Ohbox" />, Reading: "reader" }),
  news: pressing("news", { kind: "wide", Wide: () => <Pressing at="News" /> }),
  search: pressing("search", { kind: "wide", Wide: () => <Pressing at="Search" /> }),
};

function overTheGround(mail: FakeMail, address: FakeAddress, places: Partial<FramePlaces>) {
  const { host } = fakeHost({
    engine: mail.engine,
    service: "self",
    scope: SCOPE,
    places,
    reader: READER,
    above: MailGround,
    address,
  });
  /* The key map's registry stands above the frame, as a shell's does: the seam declares its z into it. */
  return (
    <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
      <KeymapProvider>
        <Frame host={host} />
      </KeymapProvider>
    </TextProvider>
  );
}
const visit = (address: FakeAddress, to: string) => act(() => address.visit(to));

beforeEach(() => {
  seam.mounts = 0;
  seam.live = 0;
  met.length = 0;
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("one press seam a frame, over the mail ground", () => {
  it("the room mounts it once, and a walk over three places of three bodies leaves it mounted", () => {
    const address = fakeAddress("#/ohbox");
    render(overTheGround(fakeMail([letter("m1")]), address, QUIET));
    expect(screen.getByText("the Ohbox")).toBeTruthy();
    expect(seam, "at the Ohbox").toEqual({ mounts: 1, live: 1 });
    visit(address, "#/reads");
    expect(screen.getByText("News")).toBeTruthy();
    expect(seam, "at News").toEqual({ mounts: 1, live: 1 });
    visit(address, "#/search");
    expect(screen.getByText("Search")).toBeTruthy();
    expect(seam, "at Search").toEqual({ mounts: 1, live: 1 });
    visit(address, "#/ohbox");
    expect(screen.getByText("the Ohbox")).toBeTruthy();
    expect(seam, "at the Ohbox again").toEqual({ mounts: 1, live: 1 });
  });

  it("a delete a closed tab left in the journal is replayed once, at the mount, and not again on the walk", async () => {
    const mail = fakeMail([letter("m1")]);
    const replayed: string[] = [];
    const replay = mail.engine.replayDelete.bind(mail.engine);
    mail.engine.replayDelete = (messageId, opts) => {
      replayed.push(messageId);
      return replay(messageId, opts);
    };
    armDeleteIntent({ id: "the-press-of-a-closed-tab", messageIds: ["m1"], at: Date.now() }, SCOPE);
    const address = fakeAddress("#/reads");
    render(overTheGround(mail, address, QUIET));
    await waitFor(() => expect(replayed, "the journal was not replayed at the mount").toEqual(["m1"]));
    visit(address, "#/ohbox");
    visit(address, "#/search");
    visit(address, "#/reads");
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(replayed, "the journal was replayed again on the walk").toEqual(["m1"]);
  });

  it("a delete pressed at one place is taken back with z at another, and it is one seam at all three", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const mail = fakeMail([letter("m1")]);
      const address = fakeAddress("#/reads");
      render(overTheGround(mail, address, PRESSING));
      fireEvent.click(screen.getByRole("button", { name: "Delete m1" }));
      expect(screen.getByText("News: held m1")).toBeTruthy();
      /* The walk ends no window: the letter is still held at the next place, and nothing has left for the server. */
      visit(address, "#/ohbox");
      expect(screen.getByText("the Ohbox: held m1")).toBeTruthy();
      expect(mail.mutations).toEqual([]);
      fireEvent.keyDown(document.body, { key: "z" });
      expect(screen.getByText("the Ohbox: held none")).toBeTruthy();
      visit(address, "#/search");
      expect(screen.getByText("Search: held none")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(UNDO_MS + 2000);
      });
      expect(mail.mutations, "the delete that was taken back left for the server").toEqual([]);
      expect(met).toHaveLength(3);
      expect(new Set(met).size, "the places pressed through more than one seam").toBe(1);
      expect(seam).toEqual({ mounts: 1, live: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * WHAT A PLACE READS OF THE GROUND, as words on the page: the row's two picture fields and whether it is known, the
 * partition's own addresses and its History, and the letters the presented mirror holds.
 */
function Reads() {
  const row = useConsent();
  const { ownAddresses, consentView } = usePartition();
  const presented = usePresented();
  const { mailboxes } = useMailState();
  const history =
    consentView === null ? "unpartitioned" : consentView.history.map((m) => m.id).join(", ") || "empty";
  const shown = presented
    .list<EngineMessage>("message")
    .map((m) => m.id)
    .sort()
    .join(", ");
  return (
    <ul>
      <li>{`pictures ${row.blockRemoteImages ? "manual" : "auto"}, pixels ${row.blockTrackingPixels ? "blocked" : "loaded"}`}</li>
      <li>{`the row is ${row.known ? "known" : "at rest"}, quiet after ${row.dormancyDays} days`}</li>
      <li>{`own: ${ownAddresses.join(", ") || "nobody"}`}</li>
      <li>{`history: ${history}`}</li>
      <li>{`presented: ${shown}`}</li>
      <li>{`mailboxes: ${mailboxes === null ? "not read" : mailboxes.length}`}</li>
    </ul>
  );
}
const READING: Partial<FramePlaces> = {
  ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: Reads } },
};

/** A consent wire that counts how often its row is asked for, and answers what the case says (or never). */
function consentWire(answer: (() => Promise<unknown>) | "never") {
  const asked = { state: 0 };
  const wire = {
    state: () => {
      asked.state += 1;
      return answer === "never" ? new Promise(() => undefined) : answer();
    },
  } as unknown as ConsentWire;
  return { wire, asked };
}

interface Over {
  readonly mail: FakeMail;
  readonly scope: string | null;
  readonly consent?: ConsentWire | None;
  readonly mailboxes?: HostReads["mailboxes"];
  readonly above?: typeof MailGround | None;
}
function reading({ mail, scope, consent = NONE, mailboxes = NONE, above = MailGround }: Over) {
  const { host } = fakeHost({
    engine: mail.engine,
    service: "self",
    scope,
    places: READING,
    reader: READER,
    above,
    mailboxes,
    wires: { consent },
    address: fakeAddress("#/ohbox"),
  });
  return (
    <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>
  );
}
const settled = () => act(async () => new Promise((r) => setTimeout(r, 20)));
/** The letters' sender, admitted by a rule: the partition presents a decided sender's mail where the mailbox has it. */
const SENDER_ADMITTED = {
  "rule:r1": {
    id: "r1",
    kind: "sender",
    match: "ben@kiln.example",
    destination: "INBOX",
    priority: 0,
    provenance: "manual",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

/** The sentence a render under it threw, kept for the case to read. */
class Thrown extends Component<{ readonly children: ReactNode }, { readonly said: string | null }> {
  override state = { said: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { said: error.message };
  }
  override render() {
    return this.state.said === null ? this.props.children : <p>{`thrown: ${this.state.said}`}</p>;
  }
}
/** React says every throw of a render on the console as well; these cases read the sentence off the page. */
function quietly<T>(run: () => T): T {
  const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    return run();
  } finally {
    said.mockRestore();
  }
}

describe("what the mail ground stands is under the frame's scope, and never another's", () => {
  it("under a scope the frame refuses, nothing of the ground is mounted and no wire is asked", async () => {
    for (const scope of [null, "", "local", "anon", "a:b"]) {
      const { wire, asked } = consentWire("never");
      let read = 0;
      const mailboxes = async () => {
        read += 1;
        return [];
      };
      const mail = fakeMail([letter("m1")]);
      const { unmount } = render(reading({ mail, scope, consent: wire, mailboxes }));
      await settled();
      expect(screen.queryByText(/^pictures /), `a place read the ground under ${String(scope)}`).toBeNull();
      expect({ asked: asked.state, read }, `under ${String(scope)}`).toEqual({ asked: 0, read: 0 });
      expect(mail.told, `the engine was told a cutline under ${String(scope)}`).toEqual({
        cutlines: [],
        sentFolders: [],
      });
      unmount();
    }
  });

  it("the answer one account left on this device is not read under another account's scope", async () => {
    localStorage.setItem(
      bootCacheKey(CONSENT_BOOT_SCOPE, "acct-a"),
      JSON.stringify({ v: 1, seedConfirmedAt: null, dormancyDays: 30, screeningBaselineAt: null }),
    );
    const { wire } = consentWire("never");
    const mail = fakeMail([letter("m1")]);
    const { rerender } = render(reading({ mail, scope: "acct-a", consent: wire }));
    await settled();
    expect(screen.getByText("the row is known, quiet after 30 days")).toBeTruthy();
    rerender(reading({ mail, scope: "acct-b", consent: wire }));
    await settled();
    expect(screen.getByText("the row is at rest, quiet after 60 days")).toBeTruthy();
    expect(screen.queryByText(/quiet after 30 days/)).toBeNull();
  });

  it("the remembered own addresses are read by the name the engine's mirror carries, not by the host's scope", async () => {
    const mail = fakeMail([letter("m1")]);
    registerSyncGate(mail.engine, createSyncGate("acct-of-the-mirror"));
    localStorage.setItem(
      bootCacheKey("own-addresses", "acct-of-the-mirror"),
      JSON.stringify(["me@studio.example"]),
    );
    localStorage.setItem(bootCacheKey("own-addresses", SCOPE), JSON.stringify(["someone@elsewhere.example"]));
    render(reading({ mail, scope: SCOPE }));
    await settled();
    expect(screen.getByText("own: me@studio.example")).toBeTruthy();
  });
});

describe("what the mail ground stands never widens what a host did not answer", () => {
  it("over a host with no consent wire the row rests: pictures on the per-letter press, pixels blocked, whatever this device remembers", async () => {
    localStorage.setItem(
      bootCacheKey(CONSENT_BOOT_SCOPE, SCOPE),
      JSON.stringify({
        v: 1,
        seedConfirmedAt: "2026-01-01T00:00:00.000Z",
        dormancyDays: 30,
        screeningBaselineAt: null,
      }),
    );
    const mail = fakeMail([letter("m1")]);
    render(reading({ mail, scope: SCOPE }));
    await settled();
    expect(screen.getByText("pictures manual, pixels blocked")).toBeTruthy();
    expect(screen.getByText("the row is at rest, quiet after 60 days")).toBeTruthy();
    /* No read of the mailbox facts either: the host answered none, and nothing is guessed for it. */
    expect(screen.getByText("mailboxes: not read")).toBeTruthy();
    expect(screen.getByText("own: nobody")).toBeTruthy();
  });

  it("a wire that answers is asked once, and pictures open only by its own answer", async () => {
    const { wire, asked } = consentWire(async () => ({
      seedConfirmedAt: null,
      dormancyDays: 45,
      blockRemoteImagesAt: null,
      loadTrackingPixelsAt: null,
    }));
    const mail = fakeMail([letter("m1")]);
    render(reading({ mail, scope: SCOPE, consent: wire }));
    /* Before the answer: the protective side. */
    expect(screen.getByText("pictures manual, pixels blocked")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("the row is known, quiet after 45 days")).toBeTruthy());
    expect(screen.getByText("pictures auto, pixels blocked")).toBeTruthy();
    await settled();
    expect(asked.state, "the consent wire was asked more than once by one mounted frame").toBe(1);
    expect(mail.told.cutlines, "the engine was told the cutline the lists are drawn with, once").toEqual([
      { dormancyDays: 45, scope: "window" },
    ]);
  });

  it("the presented mirror a place reads leaves out what the seam holds back, in the very commit the seam says it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const mail = fakeMail([letter("m1"), letter("m2")], [], {}, SENDER_ADMITTED);
      function Both() {
        return (
          <>
            <Reads />
            <Pressing at="here" />
          </>
        );
      }
      const places: Partial<FramePlaces> = {
        ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: Both } },
      };
      const { host } = fakeHost({
        engine: mail.engine,
        service: "self",
        scope: SCOPE,
        places,
        reader: READER,
        above: MailGround,
        address: fakeAddress("#/ohbox"),
      });
      /* The page as it stood at every commit: what the seam holds back, and what the presented mirror lists. */
      const line = (start: string) => screen.queryByText((text) => text.startsWith(start))?.textContent ?? "";
      const commits: { held: string; presented: string }[] = [];
      render(
        <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
          <Profiler
            id="frame"
            onRender={() => void commits.push({ held: line("here: held "), presented: line("presented: ") })}
          >
            <KeymapProvider>
              <Frame host={host} />
            </KeymapProvider>
          </Profiler>
        </TextProvider>,
      );
      expect(screen.getByText("presented: m1, m2")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Delete m1" }));
      expect(screen.getByText("presented: m2")).toBeTruthy();
      expect(
        commits.some((c) => c.held === "here: held m1"),
        "no commit was seen with the letter held back",
      ).toBe(true);
      expect(
        commits.filter((c) => c.held.includes("m1") && c.presented.includes("m1")),
        "a commit listed the letter the seam already held back",
      ).toEqual([]);
      fireEvent.keyDown(document.body, { key: "z" });
      expect(screen.getByText("presented: m1, m2")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a reader of the mail ground outside its provider fails closed", () => {
  const under = (above: Over["above"], Wide: () => ReactNode) => {
    const { host } = fakeHost({
      engine: fakeMail([letter("m1")]).engine,
      service: "self",
      scope: SCOPE,
      places: { ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide } } },
      reader: READER,
      above,
      address: fakeAddress("#/ohbox"),
    });
    return quietly(() =>
      render(
        <Thrown>
          <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
            <Frame host={host} />
          </TextProvider>
        </Thrown>,
      ),
    );
  };

  it("with no ground above, each reader throws its own sentence; the reading column's own reader reads null", () => {
    const sentences: Array<readonly [string, () => unknown]> = [
      ["useConsent: no consent row stands above (ConsentContext)", useConsent],
      ["usePartition: no partition stands above (PartitionContext)", usePartition],
      ["usePresented: no presented mirror stands above (PresentedMirrorContext)", usePresented],
      ["useMailState must be used inside <MailStateProvider>", useMailState],
    ];
    for (const [sentence, reader] of sentences) {
      const view = under(NONE, function Reading() {
        reader();
        return <p>read with nothing above</p>;
      });
      expect(screen.getByText(`thrown: ${sentence}`)).toBeTruthy();
      expect(screen.queryByText("read with nothing above")).toBeNull();
      view.unmount();
    }
    /* The reading column's own arm: on a host that hands a reader and no ground it reads null and fails closed. */
    under(NONE, function ReadingColumn() {
      return <p>{usePresentedMirror() === null ? "no mirror was handed" : "a mirror nobody handed"}</p>;
    });
    expect(screen.getByText("no mirror was handed")).toBeTruthy();
  });

  it("each mount of the ground stands on the one above it: alone, it throws that one's sentence", () => {
    const alone: Array<readonly [string, (props: { children: ReactNode }) => ReactNode]> = [
      ["useMailState must be used inside <MailStateProvider>", ConsentMount],
      ["useMailState must be used inside <MailStateProvider>", PresentedMount],
      [
        "useConsent: no consent row stands above (ConsentContext)",
        ({ children }) => (
          <MailStateMount>
            <PresentedMount>{children}</PresentedMount>
          </MailStateMount>
        ),
      ],
    ];
    for (const [sentence, above] of alone) {
      const view = under(above, () => <p>drawn over half a ground</p>);
      expect(screen.getByText(`thrown: ${sentence}`)).toBeTruthy();
      expect(screen.queryByText("drawn over half a ground")).toBeNull();
      view.unmount();
    }
  });
});

describe("the two doors of a letter, mounted by the ground", () => {
  /** What a place reads of the doors, as a seat does, said of one letter in the reader's own terms. */
  function ReadsTheDoors() {
    const doors = useDoors();
    const { known } = useConsent();
    const pictures =
      doors.pictures === undefined
        ? "no picture door"
        : letterPictures({ id: "m1" }, false, doors.pictures, "none", true, true).remoteLoaded
          ? "pictures by themselves"
          : "pictures on the press";
    return (
      <ul>
        <li>{pictures}</li>
        <li>{doors.files === undefined ? "no file door" : "a file door"}</li>
        <li>{known ? "the row is known" : "the row rests"}</li>
      </ul>
    );
  }
  const overTheDoors = (
    consent: ConsentWire | None,
    images: ImageWire | None,
    above: Over["above"] = MailGround,
  ) => {
    const { host } = fakeHost({
      engine: fakeMail([letter("m1")]).engine,
      service: "self",
      scope: SCOPE,
      places: {
        ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: ReadsTheDoors } },
      },
      reader: READER,
      above,
      wires: { consent, images },
      address: fakeAddress("#/ohbox"),
    });
    return (
      <Thrown>
        <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
          <Frame host={host} />
        </TextProvider>
      </Thrown>
    );
  };
  /** The account says its pictures load by themselves. */
  const saysAuto = async () => ({ seedConfirmedAt: null, dormancyDays: 45, blockRemoteImagesAt: null });
  const pipe = () => ({ fetch: vi.fn(async () => null), record: vi.fn(async () => undefined) });

  it("over a host that names no picture wire no picture door stands, whatever the account answers", async () => {
    const { wire } = consentWire(saysAuto);
    render(overTheDoors(wire, NONE));
    expect(screen.getByText("no picture door")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("the row is known")).toBeTruthy());
    expect(screen.getByText("no picture door")).toBeTruthy();
    expect(screen.getByText("no file door"), "the fake engine opens no file").toBeTruthy();
  });

  it("over a wire, no letter loads a picture by itself before the row's live answer, and the wire is asked nothing", async () => {
    const images = pipe();
    const { wire } = consentWire(saysAuto);
    render(overTheDoors(wire, images));
    expect(screen.getByText("pictures on the press")).toBeTruthy();
    expect(screen.getByText("the row rests")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("pictures by themselves")).toBeTruthy());
    expect(images.fetch, "the ground fetched a picture nobody drew").not.toHaveBeenCalled();
    expect(images.record, "the ground recorded a press nobody made").not.toHaveBeenCalled();
  });

  it("over a wire and no consent wire, every picture waits for its press", async () => {
    render(overTheDoors(NONE, pipe()));
    await settled();
    expect(screen.getByText("pictures on the press")).toBeTruthy();
  });

  it("with no ground above the doors' reader throws its own sentence, and the doors' mount alone the consent row's", () => {
    const none = quietly(() => render(overTheDoors(NONE, NONE, NONE)));
    expect(screen.getByText("thrown: useDoors: no doors stand above (DoorsContext)")).toBeTruthy();
    none.unmount();
    quietly(() => render(overTheDoors(NONE, NONE, DoorsMount)));
    expect(screen.getByText("thrown: useConsent: no consent row stands above (ConsentContext)")).toBeTruthy();
  });

  /** What a seat would hand a letter's body for m1, said as words, and a press of Show images. */
  function ReadsThePictures() {
    const doors = useDoors();
    const { known } = useConsent();
    const pictures = doors.pictures;
    const inputs =
      pictures === undefined ? null : letterPictures({ id: "m1" }, false, pictures, "none", true, true);
    const [minted, setMinted] = useState<string | null>(null);
    return (
      <ul>
        <li>
          {pictures === undefined ? "no picture door" : `pressed ${pictures.consented("m1") ? "yes" : "no"}`}
        </li>
        <li>
          {inputs === null
            ? "no inputs"
            : `loaded ${inputs.remoteLoaded ? "yes" : "no"}, pixels ${inputs.loadTrackingPixels ? "load" : "blocked"}`}
        </li>
        <li>{known ? "the row is known" : "the row rests"}</li>
        <li>{minted === null ? "nothing minted yet" : `minted: [${minted}]`}</li>
        <li>
          <button type="button" onClick={() => pictures?.consent("m1")}>
            Show images of m1
          </button>
        </li>
        <li>
          <button
            type="button"
            onClick={() =>
              setMinted(
                pictures === undefined ? "no door" : pictures.proxyFor("m1")("https://images.example/x.png"),
              )
            }
          >
            Mint an address for m1
          </button>
        </li>
      </ul>
    );
  }
  const overThePictures = (
    mail: FakeMail,
    scope: string,
    consent: ConsentWire | None,
    images: ImageWire | None,
  ) => {
    const { host } = fakeHost({
      engine: mail.engine,
      service: "self",
      scope,
      places: {
        ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: ReadsThePictures } },
      },
      reader: READER,
      above: MailGround,
      wires: { consent, images },
      address: fakeAddress("#/ohbox"),
    });
    return (
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Frame host={host} />
      </TextProvider>
    );
  };

  describe("the ground's pixel switch is the row's own", () => {
    it("an account that loads pictures and blocks pixels: nothing before its answer, pictures and no pixel after it", async () => {
      const mail = fakeMail([letter("m1")]);
      const { wire } = consentWire(async () => ({
        seedConfirmedAt: null,
        dormancyDays: 45,
        blockRemoteImagesAt: null,
        loadTrackingPixelsAt: null,
      }));
      render(overThePictures(mail, SCOPE, wire, pipe()));
      expect(screen.getByText("loaded no, pixels blocked"), "before the answer").toBeTruthy();
      await waitFor(() => expect(screen.getByText("the row is known")).toBeTruthy());
      expect(
        screen.getByText("loaded yes, pixels blocked"),
        "a pixel rode the pictures against the account's answer",
      ).toBeTruthy();
    });

    it("an account that loads pixels too: they ride the pictures only after its own answer", async () => {
      const mail = fakeMail([letter("m1")]);
      const { wire } = consentWire(async () => ({
        seedConfirmedAt: null,
        dormancyDays: 45,
        blockRemoteImagesAt: null,
        loadTrackingPixelsAt: "2026-01-01T00:00:00.000Z",
      }));
      render(overThePictures(mail, SCOPE, wire, pipe()));
      expect(screen.getByText("loaded no, pixels blocked"), "before the answer").toBeTruthy();
      await waitFor(() => expect(screen.getByText("the row is known")).toBeTruthy());
      expect(screen.getByText("loaded yes, pixels load")).toBeTruthy();
    });

    it("over no consent wire: no picture and no pixel by itself", async () => {
      const mail = fakeMail([letter("m1")]);
      render(overThePictures(mail, SCOPE, NONE, pipe()));
      await settled();
      expect(screen.getByText("loaded no, pixels blocked")).toBeTruthy();
    });
  });

  describe("the ground's picture door and the account boundary", () => {
    it("a picture's address is minted only while this window may read for the account its engine was opened for", async () => {
      const mail = fakeMail([letter("m1")]);
      const said: { identity: SyncIdentity } = { identity: "holds" };
      registerSyncGate(mail.engine, {
        owner: SCOPE,
        guard: (adapter: unknown) => adapter,
        identity: () => said.identity,
        confirm() {},
        onOpen() {},
        onNeedsConfirm() {},
        claim() {},
      } as unknown as SyncGate);
      const origin = {
        address: (m: string, u: string) =>
          `${window.location.origin}/api/img?mid=${m}&u=${encodeURIComponent(u)}`,
        record: vi.fn(async () => undefined),
      };
      render(overThePictures(mail, SCOPE, NONE, origin));
      fireEvent.click(screen.getByRole("button", { name: "Mint an address for m1" }));
      expect(
        screen.getByText(/^minted: \[http.*\/api\/img\?mid=m1/),
        "no address while the window may read",
      ).toBeTruthy();
      said.identity = "contradicted";
      await settled();
      fireEvent.click(screen.getByRole("button", { name: "Mint an address for m1" }));
      expect(
        screen.getByText("minted: []"),
        "an address was minted while another account holds the window",
      ).toBeTruthy();
    });
  });

  describe("the ground's picture door and the scope", () => {
    it("a press of Show images made under scope A is not read under scope B, and B's press is B's alone", async () => {
      const mail = fakeMail([letter("m1")]);
      const images = pipe();
      const { rerender } = render(overThePictures(mail, "acct-a", NONE, images));
      expect(screen.getByText("pressed no")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Show images of m1" }));
      await waitFor(() => expect(screen.getByText("pressed yes")).toBeTruthy());
      expect(screen.getByText("loaded yes, pixels blocked")).toBeTruthy();
      expect(images.record.mock.calls, "the press under A").toEqual([["m1"]]);

      rerender(overThePictures(mail, "acct-b", NONE, images));
      await settled();
      expect(screen.getByText("pressed no"), "B read the press A made").toBeTruthy();
      expect(screen.getByText("loaded no, pixels blocked"), "B's letter loaded by A's press").toBeTruthy();
      expect(images.fetch, "a picture was fetched under B").not.toHaveBeenCalled();
      expect(images.record.mock.calls, "a press was recorded under B that nobody made there").toEqual([
        ["m1"],
      ]);
    });

    it("two frames of two scopes in one page: a press in A is A's alone", async () => {
      const a = pipe();
      const b = pipe();
      render(
        <>
          <section aria-label="frame a">
            {overThePictures(fakeMail([letter("m1")]), "acct-a", NONE, a)}
          </section>
          <section aria-label="frame b">
            {overThePictures(fakeMail([letter("m1")]), "acct-b", NONE, b)}
          </section>
        </>,
      );
      const inA = within(screen.getByRole("region", { name: "frame a" }));
      const inB = within(screen.getByRole("region", { name: "frame b" }));
      fireEvent.click(inA.getByRole("button", { name: "Show images of m1" }));
      await waitFor(() => expect(inA.getByText("pressed yes")).toBeTruthy());
      await settled();
      expect(inB.getByText("pressed no"), "frame B read the press made in frame A").toBeTruthy();
      expect(inB.getByText("loaded no, pixels blocked")).toBeTruthy();
      expect({ a: a.record.mock.calls, b: b.record.mock.calls }).toEqual({ a: [["m1"]], b: [] });
    });
  });
});
