/** Mount the application's first-run stage with the mailbox facts, actions, and address supplied by a test. */
import { act, render } from "@testing-library/react";
import { useSyncExternalStore, type ReactNode } from "react";
import type { FirstRunAbout, FirstRunGround, FirstRunRow } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import type { FrameHost } from "../../../packages/app/src/frame/contract.js";
import { NONE, type ConnectWire, type FirstRunWire, type HostCapabilities } from "../../../packages/app/src/host/index.js";
import { firstRunStage } from "../../../packages/app/src/mailboxes/first-run/stage.js";
import type { FirstRunSlots } from "../../../packages/app/src/mailboxes/first-run/index.js";
import { TextProvider } from "../../../packages/app/src/text/index.js";
import frame from "../../../packages/app/messages/frame.en.json" with { type: "json" };
import screener from "../../../packages/app/messages/screener.en.json" with { type: "json" };
import accountDe from "../../../packages/app/messages/account.de.json" with { type: "json" };
import doorsDe from "../../../packages/app/messages/doors.de.json" with { type: "json" };
import mailboxesDe from "../../../packages/app/messages/mailboxes.de.json" with { type: "json" };
import frameDe from "../../../packages/app/messages/frame.de.json" with { type: "json" };
import screenerDe from "../../../packages/app/messages/screener.de.json" with { type: "json" };
import { fakeHost, NO_ENGINE } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, movable } from "../../../packages/app/test/support/fake-window.js";
import { WORDS, factorButtons, id } from "../../../packages/app/test/mailboxes/connect/support.js";

/** The stage's words in German: the same catalogues as `WORDS` and the frame's, their German twins. */
const DE = { ...accountDe, ...doorsDe, ...mailboxesDe, ...frameDe, ...screenerDe };

/** A mailbox row as the ground hands it: read, looked at, nothing consented yet. */
export function stageRow(over: Partial<FirstRunRow> = {}): FirstRunRow {
  return {
    id: id("mb-1"),
    address: "me@example.invalid",
    organizerRole: "reader",
    organizedBy: null,
    organizerState: null,
    organizerChecked: true,
    organizeConsentedAt: null,
    initialImportCompletedAt: null,
    importOver: false,
    ...over,
  } as FirstRunRow;
}

const ABOUT: FirstRunAbout = {
  queuedSenders: 0,
  pull: { screened: 0, history: 0, pulled: 0, whole: false },
  sender: null,
  queueSettling: false,
  rereadQueue: async () => {},
};

export interface MountedStage {
  readonly el: HTMLElement;
  /** The step's heading: the stage's level-1 sentence. */
  heading(): string;
  /** A button by its accessible name (its text, a key hint after it). */
  press(name: string): Promise<void>;
  /** A radio by its accessible name. */
  pick(name: string): Promise<void>;
  /** The mailbox rows the ground hands from now on, as a shell's fill moves them (the stage reads them again). */
  move(rows: readonly FirstRunRow[]): Promise<void>;
  /** The rows the ground hands now. */
  rows(): readonly FirstRunRow[];
  /** The account's facts changed while the stage was open. */
  moveAccount(account: FirstRunGround["account"]): Promise<void>;
  unmount(): void;
  /** The address the frame stands at now (a run that ends goes to its place). */
  address(): string;
  /** Every address the frame wrote, in order, and how (a push or a replace). */
  writes(): readonly { readonly next: string; readonly how: "push" | "replace" }[];
  /** The browser moves the address itself (Back, a typed link): the frame reads it, nothing is written. */
  visit(hash: string): Promise<void>;
}

export async function mountStage(opts: {
  rows: readonly FirstRunRow[];
  at?: string;
  verbs?: Partial<FirstRunWire>;
  door?: HostCapabilities["firstRunDoor"];
  /** Whose service this is: a holder named by the managed service is said as ohmail Cloud only on it. */
  service?: "self" | "managed";
  /** The ground's refresh: a write's answer reads the facts again (default: nothing moves). */
  refresh?: () => Promise<void>;
  /** The rows the facts hold now: the ground's refresh hands them (the server's next read after a write). */
  live?: () => readonly FirstRunRow[];
  /** What the ground says about the run's mailbox, over the quiet default (no queue, nothing pulled). */
  about?: Partial<FirstRunAbout>;
  /** What the place behind the stage draws (its own key bindings, say): the Ohbox's wide pane. */
  behind?: () => ReactNode;
  /** The connect wire the mailbox step's form runs on (default: none, the step draws no form). */
  connect?: ConnectWire;
  /** The second factor's slot (default: the three-button stand-in, "verify", "cancel", "discard"). */
  factor?: FirstRunSlots["factor"];
  /** The language the stage speaks (default English). */
  locale?: "en" | "de";
  /** What the account stored of the window, only where something is stored. */
  screening?: FirstRunGround["screening"];
  /** The account's own facts (default: setup never left). */
  account?: FirstRunGround["account"];
  /**
   * The ground's fill as a host composes it, A HOOK run where the ground is read (the same hook on every render of a
   * mount): it may read a store of the case's own and hold state (`useFirstRunQueueSettle`, as `live.ts` does), and
   * hands the ground the stage reads.
   */
  fill?: (ground: FirstRunGround) => FirstRunGround;
}): Promise<MountedStage> {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  const first: FirstRunGround = {
    rows: opts.rows,
    account: opts.account ?? { onboardingCompletedAt: null },
    ...(opts.screening ? { screening: opts.screening } : {}),
    accountOrganizer: null,
    about: () => ({ ...ABOUT, ...opts.about }),
    refresh: async () => {
      await opts.refresh?.();
      if (opts.live) facts.set({ ...facts.read(), rows: opts.live() });
    },
    drawn: () => {},
  };
  const facts = movable(first);
  /* The ground as a shell's fill reads it: a hook, the rows moved by the case. */
  const fill = opts.fill;
  function useGround(): FirstRunGround {
    const ground = useSyncExternalStore(facts.subscribe, facts.read);
    return fill ? fill(ground) : ground;
  }
  /* A case's verbs over the defaults, a getter kept as a getter (the AI answer a host reads live). */
  const verbs = Object.defineProperties(
    { ai: "unset", organize: async () => "stored", complete: async () => {}, setAiEnabled: async () => {} },
    Object.getOwnPropertyDescriptors(opts.verbs ?? {}),
  ) as unknown as FirstRunWire;
  const address = fakeAddress(opts.at ?? "#/first-run");
  const made = fakeHost({
    engine: NO_ENGINE,
    service: opts.service ?? "self",
    scope: "acct-1",
    address,
    places: { ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: opts.behind ?? (() => null) } } },
    stages: {
      firstRun: firstRunStage({
        factor: opts.factor ?? factorButtons({ asks: [] as never[] }),
        pair: NONE,
        aiProvider: NONE,
        calendar: NONE,
        ground: useGround,
      }),
    },
  });
  const host: FrameHost = {
    ...made.host,
    capabilities: { ...made.host.capabilities, firstRunDoor: opts.door ?? "local" },
    wires: { ...made.host.wires, firstRun: verbs, connect: opts.connect ?? NONE },
  };
  let el!: HTMLElement;
  let unmount!: () => void;
  await act(async () => {
    ({ container: el, unmount } = render(
      <TextProvider
        locale={opts.locale ?? "en"}
        messages={(opts.locale === "de" ? DE : { ...WORDS, ...frame, ...screener }) as never}
        timeZone="UTC"
      >
        <Frame host={host} />
      </TextProvider>,
    ));
  });
  const settle = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  const named = (n: string) => (e: Element) =>
    (e.getAttribute("aria-label") ?? e.textContent ?? "").trim().startsWith(n);
  return {
    el,
    unmount,
    rows: () => facts.read().rows ?? [],
    address: () => address.read(),
    writes: () => address.writes,
    visit: async (hash) => {
      await act(async () => {
        address.visit(hash);
        await settle();
      });
    },
    move: async (rows) => {
      await act(async () => {
        facts.set({ ...facts.read(), rows });
        await settle();
      });
    },
    moveAccount: async (account) => {
      await act(async () => {
        facts.set({ ...facts.read(), account });
        await settle();
      });
    },
    heading: () => (el.querySelector("h1")?.textContent ?? "").trim(),
    press: async (n) => {
      const button = [...el.querySelectorAll("button")].find(named(n));
      if (!button) throw new Error(`no button named ${JSON.stringify(n)}`);
      await act(async () => {
        button.click();
        await settle();
      });
    },
    pick: async (n) => {
      const radio = [...el.querySelectorAll<HTMLElement>("[role=radio], input[type=radio]")].find(
        (r) => (r.getAttribute("aria-label") ?? r.closest("label")?.textContent ?? r.textContent ?? "").trim().startsWith(n),
      );
      if (!radio) throw new Error(`no radio named ${JSON.stringify(n)}`);
      await act(async () => {
        radio.click();
        await settle();
      });
    },
  };
}
