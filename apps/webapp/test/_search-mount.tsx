/**
 * MOUNT SEARCH AND TIME IT TO THE RENDERED LIST — shared by the render budget test and the lane's
 * large-corpus end-to-end reading. `rendered(n)` resolves the instant the DOM first holds `n` result rows
 * (a MutationObserver, not a poll), so the time read is the paint's, not a timer's.
 */
import * as React from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { OhmailEngine } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SearchView } from "../app/views/SearchView";
import { KeymapProvider } from "@ohmail/app/keys";

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

export function mountSearch(engine: OhmailEngine, query: string, now = new Date()): MountedSearch {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let commits = 0;
  const root: Root = createRoot(host);
  root.render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC" now={now}>
      <KeymapProvider>
        <React.Profiler id="search" onRender={(_id, phase) => { if (phase !== "nested-update") commits += 1; }}>
          <SearchView engine={engine} version={1} now={now} query={query} onQuery={() => {}} onOpen={() => {}} />
        </React.Profiler>
      </KeymapProvider>
    </NextIntlClientProvider>,
  );
  const paint = (): Paint => ({ ...threadClock(), commits });
  return {
    host,
    rendered: (n) => new Promise<Paint>((resolve) => {
      const count = () => host.querySelectorAll(".hit").length;
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

/**
 * A PERSON'S VISIT TO SEARCH, by what they can do: type a question, press Enter, press a facet by its name, choose an
 * order by its name, scroll to the list's end. The search screen's calls-per-setting test drives it; when the screen
 * is swapped, this mount is re-pointed and the test is not edited.
 */
export interface SearchVisit {
  type: (q: string) => void;
  enter: () => void;
  facet: (name: string) => boolean;
  sort: (order: "relevance" | "date_desc" | "date_asc" | "mailbox" | "sender") => void;
  scrollEnd: () => void;
  unmount: () => void;
}

export function mountSearchVisit(engine: OhmailEngine, now: Date): SearchVisit {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const door: { type?: (q: string) => void } = {};
  function Live() {
    const [query, setQuery] = React.useState("");
    door.type = setQuery;
    return <SearchView engine={engine} version={1} indexRev={0} now={now} query={query} onQuery={setQuery} onOpen={() => {}} />;
  }
  root.render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC" now={now}>
      <KeymapProvider>
        <Live />
      </KeymapProvider>
    </NextIntlClientProvider>,
  );
  const box = () => host.querySelector<HTMLInputElement>(`input[aria-label="${messages.search.aria}"]`);
  return {
    type: (q) => door.type!(q),
    enter: () => box()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    facet: (name) => {
      const b = [...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((x) => (x.textContent ?? "").includes(name));
      b?.click();
      return b !== undefined;
    },
    sort: (order) => {
      const select = host.querySelector<HTMLSelectElement>("select")!;
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      set.call(select, order);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    scrollEnd: () => host.querySelector('[role="list"]')?.closest(".scroller")?.dispatchEvent(new Event("scroll")),
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}
