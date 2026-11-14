/** @vitest-environment jsdom */
/**
 * ONE PRESS SEAM PER FRAME, WITH THE REAL OLD SHELL BESIDE A READER'S PLACE (RULING-MEETING-LINE, one seam). A TEST HOST:
 * the real frame over today's views, mounted as `_todays-shell.tsx` mounts them, whose places are today's with ONE
 * stub place of another body that names the reader, and whose host hands the real reader (`readerEntry`, its body a
 * double). No real host is mixed so; this is the harness the scope switch reuses (a walk to a place of another
 * body and back).
 *
 * The real `useShellDispatch` is counted live through a wrapper, each call by the file that made it. Walking today's
 * Ohbox, the stub place and today's Ohbox again, at most one seam is live after every step: the old shell's on
 * today's places, the room's on the reader's.
 */
import { createElement as h, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellDispatchInput } from "@ohmail/app-logic/press/shell-dispatch";
import { NONE } from "@ohmail/app/host";
import type { FramePlaces, PlaceEntry } from "@ohmail/app/frame";
import { TextProvider } from "@ohmail/app/text";
import { readerEntry } from "@ohmail/app/reader";
import type { OhmailEngine } from "@ohmail/client-engine";
import messages from "../../messages/en.json";
import { act, engineOver, msg, NOW, setup, storeWith, teardown, waitFor, S } from "../_view-shell";
import { hostFromTodaysInputs } from "../_todays-shell";

type Owner = "shell" | "room" | "other";
const live = vi.hoisted(() => ({ seams: [] as Array<{ owner: string }>, peak: 0 }));
vi.mock("@ohmail/app-logic/press/shell-dispatch", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/press/shell-dispatch")>();
  const { useEffect, useState } = await import("react");
  /** The file that called the hook, read off the call's own stack: the old shell, or the frame's room. */
  function ownerOfCall(): string {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    const stack = new Error().stack ?? "";
    Error.stackTraceLimit = limit;
    if (/[\\/]shell[\\/]AppShell\.tsx/.test(stack)) return "shell";
    if (/[\\/]frame[\\/]room\.tsx/.test(stack)) return "room";
    return "other";
  }
  return {
    ...real,
    useShellDispatch: (input: ShellDispatchInput) => {
      const [owner] = useState(ownerOfCall);
      const seam = real.useShellDispatch(input);
      useEffect(() => {
        const entry = { owner };
        live.seams.push(entry);
        live.peak = Math.max(live.peak, live.seams.length);
        return () => {
          live.seams.splice(live.seams.indexOf(entry), 1);
        };
      }, [owner]);
      return seam;
    },
  };
});

/** The stub place: another body, its reading column the reader's. Its id is one of today's the walk does not need. */
const STUB: PlaceEntry = {
  id: "news",
  body: "stub",
  rail: null,
  panes: { kind: "columns", List: () => null, Reading: "reader" },
};
const READER = readerEntry({
  body: () => h("p", null, "a body"),
  files: "none",
  pictures: "none",
  look: "none",
  sentCopy: "none",
});

let root: Root | null = null;

async function loaded() {
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const { EngineProvider } = await import("../../app/shell/engine");
  const { TodaysFrame } = await import("../../app/shell/TodaysFrame");
  const { NO_TODAYS } = await import("../../app/shell/todays-inputs");
  const { useTodaysSupplies } = await import("../../app/shell/todays-supplies");
  return { ThemeProvider, ToastHost, EngineProvider, TodaysFrame, NO_TODAYS, useTodaysSupplies };
}
let parts: Awaited<ReturnType<typeof loaded>> | null = null;

/** The test host: today's supplies and inputs, today's places spread with the stub, and the real reader handed. */
function Entry({ engine }: { engine: OhmailEngine }) {
  const { TodaysFrame, NO_TODAYS, useTodaysSupplies } = parts!;
  const frame = useTodaysSupplies(NONE);
  const host = useMemo(() => {
    const places = { ...frame.places, news: STUB } as unknown as FramePlaces;
    const made = hostFromTodaysInputs({ demo: false, engine }, engine, { ...frame, places }, NONE);
    return { ...made, features: { ...made.features, places, reader: READER } };
  }, [engine, frame]);
  return h(TodaysFrame, { host, todays: NO_TODAYS });
}

async function draw(engine: OhmailEngine) {
  parts ??= await loaded();
  const { ThemeProvider, ToastHost, EngineProvider } = parts;
  const tree = h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW } as never,
    h(TextProvider, { locale: "en", messages: messages as never, timeZone: "UTC" } as never,
      h(ThemeProvider as never, null, h(ToastHost as never, null,
        h(EngineProvider, { demo: false, engine } as never, h(Entry, { engine }))))));
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(tree); });
}

/** A visit as the address bar makes one: the fragment changes and the browser announces it. */
async function visit(fragment: string) {
  await act(async () => {
    window.history.replaceState(window.history.state, "", fragment);
    window.dispatchEvent(new Event("hashchange"));
  });
}

const owners = (): Owner[] => live.seams.map((s) => s.owner as Owner).sort();
const readerColumn = () => screen.queryByRole("region", { name: "Reading" });

beforeEach(() => {
  setup();
  live.seams.length = 0;
  live.peak = 0;
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  window.location.hash = "#/ohbox";
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  await teardown();
});

describe("one press seam per frame, the real old shell beside a reader's place", () => {
  it("today's Ohbox, the stub place, today's Ohbox: the shell's seam, the room's, the shell's, never two", async () => {
    const engine = engineOver(await storeWith([msg("m1")]));
    S.engine = engine;
    await draw(engine);
    await waitFor(() => live.seams.length > 0, "today's Ohbox drawn with its seam");
    expect(owners(), "today's Ohbox: the old shell's seam alone").toEqual(["shell"]);
    expect(readerColumn(), "today's Ohbox draws no reading column of the frame's").toBeNull();

    await visit("#/reads");
    await waitFor(() => readerColumn() !== null, "the stub place's reading column");
    expect(owners(), "the stub place: today's views are gone, the room's seam alone").toEqual(["room"]);

    await visit("#/ohbox");
    await waitFor(() => readerColumn() === null, "today's Ohbox again");
    expect(owners(), "today's Ohbox again: the old shell's seam alone").toEqual(["shell"]);
    expect(live.peak, "after every commit of the walk at most one seam was live").toBe(1);
  });
});
