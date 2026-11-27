/**
 * THE OHBOX UNDER A FINGER: the real frame over a fake host in a room the test names, the Ohbox's place drawn from
 * the real behaviour hook over plain letters, and a finger that moves as a browser reports it (pointer events for a
 * swipe, touch events for a pull). A test reads what the model was asked to do.
 */
import { act, render, type RenderResult } from "@testing-library/react";
import { createContext, useContext } from "react";
import { useOhboxList, type OhboxListInput } from "@ohmail/app-logic/ohbox";
import { DEFAULT_AFTER_VERB } from "@ohmail/app-logic/press/after-verb";
import type { MessageAction } from "@ohmail/app-logic/press/actions";
import { Frame } from "../../src/frame/Frame.js";
import { useFrame } from "../../src/frame/commands.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import type { HostContract } from "../../src/host/index.js";
import { OhboxAbove, OhboxList, type OhboxBeside } from "../../src/ohbox/index.js";
import { TextProvider } from "../../src/text/index.js";
import { beside, WORDS, type Said } from "../ohbox/ohbox-world.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

export { at, msg } from "../ohbox/ohbox-world.js";

/** Vertical displacement of the list content, in px, while its scroller stays in place. */
export function pulledDistance(scroller: HTMLElement): number {
  return Number.parseFloat(scroller.style.getPropertyValue("--pull-offset").split(" ")[1] ?? "0");
}

export interface TouchSaid extends Said {
  acted: Array<[MessageAction, string]>;
  opened: string[];
}

interface Fed {
  input: OhboxListInput;
  side: OhboxBeside;
}
const FedContext = createContext<Fed | null>(null);

function OhboxPane({ route, plan }: PaneProps) {
  const fed = useContext(FedContext)!;
  const model = useOhboxList(fed.input);
  return (
    <OhboxAbove model={model} beside={fed.side}>
      <OhboxList route={route} plan={plan} keysHere />
    </OhboxAbove>
  );
}

/** What the frame's plan says, for a case that reads it. */
export function PlanProbe({ seen }: { seen: (pointer: string) => void }) {
  seen(useFrame().plan.pointer);
  return null;
}

const OHBOX: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List: OhboxPane, Reading: () => null },
};

export interface TouchWorld {
  said: TouchSaid;
  view: RenderResult;
  host: HostContract;
  scroller(): HTMLElement;
  again(next: Partial<OhboxListInput>, side?: Partial<OhboxBeside>): void;
}

export function touchWorld(
  input: Partial<OhboxListInput>,
  opts: {
    room?: keyof typeof ROOMS;
    side?: Partial<OhboxBeside>;
    host?: (made: HostContract) => HostContract;
  } = {},
): TouchWorld {
  const said: TouchSaid = { marked: [], bulk: [], went: [], pulled: 0, markedAll: [], acted: [], opened: [] };
  let fed: Fed = {
    side: beside(said, opts.side),
    input: {
      demo: false,
      newForYou: [],
      previouslySeen: [],
      tags: [],
      now: new Date("2026-08-02T12:00:00.000Z"),
      selectedId: null,
      onSelect: (id) => {
        if (id !== null) said.opened.push(id);
      },
      onEnterReader: (id) => {
        said.opened.push(id);
      },
      onMarkSeen: (ids, unread) => {
        said.marked.push({ ids, unread });
      },
      readerId: null,
      readSetFor: (id) => [id],
      doorbellInitials: [],
      doorbellCount: 0,
      settled: true,
      owed: false,
      onDoorbell: () => {},
      onAction: (action, m) => {
        said.acted.push([action, m.id]);
      },
      onAddTag: () => {},
      onMarkAllRead: (ids) => {
        said.markedAll.push(ids);
      },
      bulk: {
        run: (action, ids) => {
          said.bulk.push({ action, ids });
          return true;
        },
        tag: () => {},
        screenPreview: () => ({ senders: 1, messages: 2, rules: 0 }),
        screen: () => true,
      },
      t: (key) => key,
      columnHidden: () => false,
      afterVerb: () => DEFAULT_AFTER_VERB,
      rowSelector: "[data-id]",
      avatarSelector: null,
      anchors: { pickTag: () => null, row: () => null },
      readColRef: { current: null },
      senderName: (m) => m.from.name ?? m.from.address,
      sentLabelOf: () => null,
      ...input,
    },
  };
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    places: { ohbox: OHBOX },
    window: fakeWindow(opts.room ?? "phone"),
  }).host;
  const host = opts.host ? opts.host(made) : made;
  const tree = () => (
    <TextProvider locale="en" messages={{ ...FRAME_WORDS.en, ...WORDS.en }} timeZone="UTC">
      <FedContext.Provider value={fed}>
        <Frame host={host} />
      </FedContext.Provider>
    </TextProvider>
  );
  const view = render(tree());
  return {
    said,
    view,
    host,
    scroller: () => view.container.ownerDocument.querySelector<HTMLElement>(".ob-scroll")!,
    again(next, side) {
      fed = { input: { ...fed.input, ...next }, side: side ? { ...fed.side, ...side } : fed.side };
      view.rerender(tree());
    },
  };
}

/* A finger, as a browser reports it. jsdom has no PointerEvent and no Touch: the fields a listener reads are set. */
export function pointer(type: string, at: { x: number; y: number }, kind = "touch", id = 1): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
  Object.defineProperties(event, { pointerType: { value: kind }, pointerId: { value: id } });
  return event;
}

function touches(type: string, at: { x: number; y: number } | null): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const list = at ? [{ clientX: at.x, clientY: at.y, identifier: 1 }] : [];
  Object.defineProperty(event, "touches", { value: list });
  return event;
}

export interface Finger {
  /** Every move goes to where the finger is now; `to` names the place relative to where it came down. */
  move(dx: number, dy: number): Finger;
  up(): void;
  /** The system took the finger (the browser's pan, or its edge-back). */
  cancel(): void;
}

/** A finger comes down on `target` and swipes or scrolls. Each step is a pointer event, as on a phone. */
export function finger(target: Element, kind = "touch", from = { x: 100, y: 300 }): Finger {
  let now = { ...from };
  act(() => {
    target.dispatchEvent(pointer("pointerdown", now, kind));
  });
  const self: Finger = {
    move(dx, dy) {
      now = { x: from.x + dx, y: from.y + dy };
      act(() => {
        target.dispatchEvent(pointer("pointermove", now, kind));
      });
      return self;
    },
    up() {
      act(() => {
        target.dispatchEvent(pointer("pointerup", now, kind));
      });
      /* The browser's click after a press that was let go where it came down, or near it. */
      act(() => {
        target.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, clientX: now.x, clientY: now.y }),
        );
      });
    },
    cancel() {
      act(() => {
        target.dispatchEvent(pointer("pointercancel", now, kind));
      });
    },
  };
  return self;
}

/** A pull at the list's top: touch events on what the finger came down on, down by `dy` in steps, then let go. */
export function pullDown(
  target: Element,
  dy: number,
  opts: { steps?: number; cancel?: boolean; hold?: boolean } = {},
): () => void {
  const from = { x: 100, y: 200 };
  const steps = opts.steps ?? 6;
  act(() => {
    target.dispatchEvent(touches("touchstart", from));
  });
  for (let k = 1; k <= steps; k++) {
    act(() => {
      target.dispatchEvent(touches("touchmove", { x: from.x, y: from.y + (dy * k) / steps }));
    });
  }
  const end = () =>
    act(() => {
      target.dispatchEvent(touches(opts.cancel ? "touchcancel" : "touchend", null));
    });
  if (!opts.hold) end();
  return end;
}
