/**
 * MOUNT SEARCH AND TIME IT TO THE RENDERED LIST — shared by the render budget test and the lane's
 * large-corpus end-to-end reading. `rendered(n)` resolves the instant the DOM first holds `n` result rows
 * (a MutationObserver, not a poll), so the time read is the paint's, not a timer's.
 */
import * as React from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { useSearchList } from "@ohmail/app-logic/search";
import { SearchAbove } from "../../../packages/app/src/search/SearchAbove";
import { SearchList } from "../../../packages/app/src/search/SearchList";
import { blankOf as searchBlankOf } from "../../../packages/app/src/search/blank";
import { TextProvider } from "@ohmail/app/text";
import { NONE } from "@ohmail/app/host";
import { layoutPlan } from "../../../packages/app/src/frame/layout-plan";
import { fakeWindow } from "../../../packages/app/test/support/fake-window";
import type { SearchBeside } from "../../../packages/app/src/search/beside";
import type { OhmailEngine, SearchHit } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { KeymapProvider } from "../../../test/support/keymap-provider";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

export interface ThreadClock {
  /** `performance.now()`. */
  at: number;
  /** This thread's time runnable and waiting for a CPU so far, in ms; null where /proc cannot say. */
  queuedMs: number | null;
}

/**
 * The wall clock beside the part of it that belongs to the HOST: field 2 of this thread's
 * schedstat is the time the kernel held it runnable with no CPU free. Wall minus that is the
 * client's own time — its work and its own waits — which is what a client budget is about.
 */
export function threadClock(): ThreadClock {
  let queuedMs: number | null = null;
  try {
    queuedMs = Number(readFileSync("/proc/thread-self/schedstat", "utf8").split(" ")[1]) / 1e6;
  } catch {
    queuedMs = null;
  }
  return { at: performance.now(), queuedMs: Number.isFinite(queuedMs) ? queuedMs : null };
}

/** The instant the rows were first all there, and the view's commits up to it. */
export interface Paint extends ThreadClock {
  /**
   * Commits of the view's tree so far (a Profiler around it), leaving out `nested-update`: a
   * re-render a layout effect asks for runs before the browser paints, and the list window
   * decides whether to window in its first layout pass, so a page that lands as rows is one
   * update and one nested update, painted once.
   */
  commits: number;
}

export interface MountedSearch {
  host: HTMLElement;
  /** Resolves at the first mutation that leaves `n` rows in the DOM. */
  rendered: (n: number) => Promise<Paint>;
  /** Commits of the view's tree so far. */
  commits: () => number;
  unmount: () => void;
}

const desktopPlan = layoutPlan(fakeWindow("desktop").read());
const searchBeside: SearchBeside = {
  words: {
    name: (mail) => mail.from.name,
    address: (mail) => mail.from.address,
    stamp: () => "10 Nov",
    place: (mail) => mail.folder === "INBOX" ? "Ohbox" : mail.folder,
    placeOfFolder: (folder) => folder,
  },
  junk: NONE,
  junkReadable: false,
  keysShown: true,
  people: NONE,
  events: NONE,
  go: { address: () => {} },
};

export function prepareSearchWindow(): void {
  window.matchMedia ??= (query) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  });
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
}

export function SearchSeat({ engine, initialQuery, onOpen = () => {} }: {
  engine: OhmailEngine;
  initialQuery: string;
  onOpen?: (hit: SearchHit) => void;
}) {
  const [query, setQuery] = React.useState(initialQuery);
  const boxRef = React.useRef<HTMLInputElement>(null);
  const scrollerRef = React.useRef<HTMLElement>(null);
  const model = useSearchList({
    engine, scope: "acct", query, onQuery: setQuery, onOpen, onExit: "none",
    boxRef, scrollerRef, t: (key) => key, searchBy: "words",
  });
  return (
    <SearchAbove model={model} beside={searchBeside} blank={searchBlankOf(model, (key) => key)}>
      <SearchList
        route={{ place: "search", sub: null, open: null, stage: null, words: {} }}
        plan={desktopPlan}
        keysHere
      />
    </SearchAbove>
  );
}

export function mountSearch(engine: OhmailEngine, query: string, now = new Date()): MountedSearch {
  prepareSearchWindow();
  const host = document.createElement("div");
  document.body.appendChild(host);
  let commits = 0;
  const root: Root = createRoot(host);
  root.render(
    <TextProvider locale="en" messages={messages} timeZone="UTC" now={now}>
      <KeymapProvider>
        <React.Profiler id="search" onRender={(_id, phase) => { if (phase !== "nested-update") commits += 1; }}>
          <SearchSeat engine={engine} initialQuery={query} />
        </React.Profiler>
      </KeymapProvider>
    </TextProvider>,
  );
  const paint = (): Paint => ({ ...threadClock(), commits });
  return {
    host,
    rendered: (n) => new Promise<Paint>((resolve) => {
      const count = () => host.querySelectorAll('[role="listitem"]').length;
      if (count() >= n) {
        resolve(paint());
        return;
      }
      const obs = new MutationObserver(() => {
        if (count() >= n) {
          obs.disconnect();
          resolve(paint());
        }
      });
      obs.observe(host, { childList: true, subtree: true });
    }),
    commits: () => commits,
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}
