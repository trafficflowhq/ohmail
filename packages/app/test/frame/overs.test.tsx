/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import { useFrame, usePaletteFeeds, usePaletteOffers } from "../../src/frame/commands.js";
import type {
  OfferFeed,
  OverEntry,
  OverProps,
  PaletteOffer,
  PaneProps,
  PlaceEntry,
} from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { NONE } from "../../src/host/index.js";
import { fakeHost, NO_ENGINE, type FakeHostInput } from "../support/fake-host.js";
import { FRAME_WORDS } from "../support/frame-words.js";

/**
 * THE OVERS AND THE OFFERS. A shell hands each over (the palette, the key sheet) or none; the frame mounts every one
 * handed, open while its `over` names it; one stands at a time and going somewhere closes it. A product's commands
 * stand in the palette's feed while their part is mounted, the product on screen first.
 */
const mounted = { palette: 0, keys: 0 };
const overOf = (id: "palette" | "keys"): OverEntry => ({
  id,
  Body: ({ open, onClose }: OverProps) => {
    useState(() => (mounted[id] += 1));
    return open ? (
      <div role="dialog" aria-label={id}>
        <button type="button" onClick={onClose}>
          close {id}
        </button>
      </div>
    ) : null;
  },
});

let feeds: readonly OfferFeed[] = [];
function Reader() {
  feeds = usePaletteFeeds();
  return null;
}
const offer = (id: string, run: () => void = () => undefined): PaletteOffer => ({
  id,
  label: id,
  icon: "search",
  run,
});
function MailOffers({ label = "mail.archive", run }: { label?: string; run?: () => void }) {
  usePaletteOffers("mail", [offer(label, run)], false);
  return null;
}
function CalendarOffers() {
  usePaletteOffers("calendar", [offer("calendar.today")], true);
  return null;
}

function List(_: PaneProps) {
  const { commands, over } = useFrame();
  const [mail, setMail] = useState(true);
  return (
    <div>
      <p>over {over ?? "none"}</p>
      <button type="button" onClick={() => commands.over("palette")}>
        palette
      </button>
      <button type="button" onClick={() => commands.over("keys")}>
        keys
      </button>
      <button type="button" onClick={() => commands.go({ place: "later" })}>
        go
      </button>
      <button type="button" onClick={() => setMail(false)}>
        drop mail
      </button>
      <Reader />
      {mail ? <MailOffers /> : null}
      <CalendarOffers />
    </div>
  );
}
const ohbox: PlaceEntry = { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: List } };
const later: PlaceEntry = {
  id: "later",
  body: "later",
  rail: null,
  panes: { kind: "wide", Wide: () => <p>later</p> },
};

function mount(more: Partial<FakeHostInput> = {}) {
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    places: { ohbox, later },
    ...more,
  });
  render(
    <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
      <Frame host={made.host} />
    </TextProvider>,
  );
  return made;
}

beforeEach(() => {
  mounted.palette = 0;
  mounted.keys = 0;
  feeds = [];
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the overs", () => {
  it("mounts every over handed, always, and opens one at a time", () => {
    mount({ overs: { palette: overOf("palette"), keys: overOf("keys") } });
    expect(mounted).toEqual({ palette: 1, keys: 1 });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "palette" }));
    expect(screen.getByRole("dialog", { name: "palette" })).toBeTruthy();
    expect(screen.getByText("over palette")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "keys" }));
    expect(screen.queryByRole("dialog", { name: "palette" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "keys" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "close keys" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("over none")).toBeTruthy();
    expect(mounted).toEqual({ palette: 1, keys: 1 });
  });

  it("closes the over standing when the person goes somewhere", () => {
    mount({ overs: { palette: overOf("palette"), keys: NONE } });
    fireEvent.click(screen.getByRole("button", { name: "palette" }));
    expect(screen.getByRole("dialog", { name: "palette" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("mounts nothing for an over handed as none, and asking for it opens nothing", () => {
    mount({ overs: { palette: NONE, keys: overOf("keys") } });
    expect(mounted).toEqual({ palette: 0, keys: 1 });
    fireEvent.click(screen.getByRole("button", { name: "palette" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refuses an over handed under another's name", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => mount({ overs: { palette: overOf("keys"), keys: NONE } })).toThrow(/handed as "palette"/);
    expect(mounted).toEqual({ palette: 0, keys: 0 });
  });
});

describe("the palette's offers", () => {
  it("lists the product on screen first, each source's offers read at the press", () => {
    let ran = 0;
    function Offers() {
      usePaletteOffers("mail", [offer("mail.archive", () => (ran += 1))], false);
      usePaletteOffers("calendar", [offer("calendar.today")], true);
      return <Reader />;
    }
    render(<FrameOf body={<Offers />} />);
    expect(feeds.map((f) => f.source)).toEqual(["calendar", "mail"]);
    feeds
      .find((f) => f.source === "mail")!
      .read()[0]!
      .run();
    expect(ran).toBe(1);
  });

  it("takes a part's offers with it when it goes", () => {
    mount();
    expect(feeds.map((f) => f.source)).toEqual(["calendar", "mail"]);
    fireEvent.click(screen.getByRole("button", { name: "drop mail" }));
    expect(feeds.map((f) => f.source)).toEqual(["calendar"]);
  });

  it("reads the newest run at the press, while the shape stands", () => {
    const runs: string[] = [];
    function Moving() {
      const [n, setN] = useState(0);
      usePaletteOffers("mail", [offer("mail.archive", () => runs.push(`run ${n}`))], true);
      return (
        <>
          <Reader />
          <button type="button" onClick={() => setN((x) => x + 1)}>
            again
          </button>
        </>
      );
    }
    render(<FrameOf body={<Moving />} />);
    const shape = feeds[0]!.shape;
    fireEvent.click(screen.getByRole("button", { name: "again" }));
    expect(feeds[0]!.shape).toBe(shape);
    act(() => feeds[0]!.read()[0]!.run());
    expect(runs).toEqual(["run 1"]);
  });
});

/** A frame whose one place draws `body`. */
function FrameOf({ body }: { body: React.ReactNode }) {
  const [made] = useState(() =>
    fakeHost({
      engine: NO_ENGINE,
      service: "self",
      scope: "acct-1",
      places: {
        ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: () => <>{body}</> } },
      },
    }),
  );
  return (
    <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
      <Frame host={made.host} />
    </TextProvider>
  );
}
