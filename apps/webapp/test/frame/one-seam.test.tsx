/** @vitest-environment jsdom */
/**
 * ONE PRESS SEAM PER FRAME, WITH THE REAL OLD SHELL AND THE SEATED OHBOX. The real frame as `_todays-shell.tsx` mounts
 * it: the hosts' own places (the Ohbox seated, a reader's place; every other one of today's views) and the shell's own
 * reader.
 *
 * The real `useShellDispatch` is counted live through a wrapper, each call by the file that made it. The old shell's
 * composition stands above every pane and hands the frame's room its own seam: walking News, the seated Ohbox and News
 * again, the one live seam is the shell's at every step, never two, never the room's, and it is mounted once. Over a
 * host that stands nothing above the panes (a test host: one stub place that names the reader, `_stub-place.tsx`) the
 * room mounts its own, only while a reader's place is on screen. And a delete a closed tab left in the journal is
 * replayed once at the mount, by that one seam.
 */
import { createElement as h, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellDispatchInput } from "@ohmail/app-logic/press/shell-dispatch";
import { armDeleteIntent } from "@ohmail/app-logic/press/delete-intents";
import { NONE } from "@ohmail/app/host";
import { PLACE_IDS, type FramePlaces, type PlaceEntry } from "@ohmail/app/frame";
import { TextProvider } from "@ohmail/app/text";
import { readerEntry } from "@ohmail/app/reader";
import type { OhmailEngine } from "@ohmail/client-engine";
import messages from "../../messages/en.json";
import { act, engineOver, msg, NOW, setup, storeWith, teardown, waitFor, S } from "../_view-shell";
import { HARNESS_SCOPE, hostFromTodaysInputs } from "../_todays-shell";
import { STUB_ADDRESS, STUB_PLACE } from "./_stub-place";

type Owner = "shell" | "room" | "other";
const live = vi.hoisted(() => ({ seams: [] as Array<{ owner: string }>, peak: 0, mounts: 0 }));
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
        live.mounts += 1;
        live.peak = Math.max(live.peak, live.seams.length);
        return () => {
          live.seams.splice(live.seams.indexOf(entry), 1);
        };
      }, [owner]);
      return seam;
    },
  };
});

/** A wide place of a body of its own, for the host that stands nothing above the panes: it draws no letter. */
function Plain() {
  return h("p", null, "a plain place");
}
const PLAIN: PlaceEntry = { id: "ohbox", body: "plain", rail: null, panes: { kind: "wide", Wide: Plain } };
const READER = readerEntry({
  body: () => h("p", null, "a body"),
  files: "none",
  pictures: "none",
  look: "none",
  sentCopy: "none",
  reply: "none",
  invitation: "none",
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

/**
 * The host: today's supplies and inputs as every shell hands them (the seated Ohbox, the shell's reader). `bare`: a
 * host that stands nothing above the panes, with a plain place where the Ohbox stands, the stub place that names the
 * reader, a reader of the test's own, and no other place.
 */
function Entry({ engine, bare }: { engine: OhmailEngine; bare: boolean }) {
  const { TodaysFrame, NO_TODAYS, useTodaysSupplies } = parts!;
  const frame = useTodaysSupplies(NONE);
  const host = useMemo((): ReturnType<typeof hostFromTodaysInputs> => {
    if (!bare) return hostFromTodaysInputs({ demo: false, engine }, engine, frame, NONE);
    const places = {
      ...Object.fromEntries(PLACE_IDS.map((id) => [id, NONE])), ohbox: PLAIN, [STUB_PLACE.id]: STUB_PLACE,
    } as unknown as FramePlaces;
    const made = hostFromTodaysInputs({ demo: false, engine }, engine, { ...frame, places }, NONE);
    return { ...made, features: { ...made.features, places, reader: READER, above: NONE } };
  }, [engine, frame, bare]);
  return h(TodaysFrame, { host, todays: NO_TODAYS });
}

async function draw(engine: OhmailEngine, bare = false) {
  parts ??= await loaded();
  const { ThemeProvider, ToastHost, EngineProvider } = parts;
  const tree = h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW } as never,
    h(TextProvider, { locale: "en", messages: messages as never, timeZone: "UTC" } as never,
      h(ThemeProvider as never, null, h(ToastHost as never, null,
        h(EngineProvider, { demo: false, engine } as never, h(Entry, { engine, bare }))))));
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

/** A view of today's the walks start from and come back to. */
const TODAYS_ADDRESS = "#/reads";
const owners = (): Owner[] => live.seams.map((s) => s.owner as Owner).sort();
const readerColumn = () => screen.queryByRole("region", { name: "Reading" });

beforeEach(() => {
  setup();
  live.seams.length = 0;
  live.peak = 0;
  live.mounts = 0;
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  window.location.hash = TODAYS_ADDRESS;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  await teardown();
});

describe("one press seam per frame, the real old shell and the seated Ohbox", () => {
  it("News, the seated Ohbox, News: the shell's seam at every step, mounted once, never the room's", async () => {
    const engine = engineOver(await storeWith([msg("m1")]));
    S.engine = engine;
    await draw(engine);
    await waitFor(() => live.seams.length > 0, "News drawn with its seam");
    expect(owners(), "News: the old shell's seam alone").toEqual(["shell"]);
    expect(readerColumn(), "a view of today's draws no reading column of the frame's").toBeNull();

    await visit("#/ohbox");
    await waitFor(() => readerColumn() !== null, "the seated Ohbox's reading column");
    expect(owners(), "the seated Ohbox: the old shell's seam still, and no seam of the room's").toEqual(["shell"]);

    await visit(TODAYS_ADDRESS);
    await waitFor(() => readerColumn() === null, "News again");
    expect(owners(), "News again: the old shell's seam alone").toEqual(["shell"]);
    expect({ peak: live.peak, mounts: live.mounts }, "one seam was live after every commit, and it was mounted once").toEqual({
      peak: 1, mounts: 1,
    });
  });

  it("over a host that stands nothing above the panes: no seam, the room's on the reader's place, none again", async () => {
    const engine = engineOver(await storeWith([msg("m1")]));
    S.engine = engine;
    window.location.hash = "#/ohbox";
    await draw(engine, true);
    await waitFor(() => screen.queryByText("a plain place") !== null, "the plain place");
    expect(owners(), "a place that draws no letter: no seam").toEqual([]);

    await visit(STUB_ADDRESS);
    await waitFor(() => readerColumn() !== null, "the stub place's reading column");
    await waitFor(() => live.seams.length > 0, "the room's seam");
    expect(owners(), "the reader's place: the room's own seam alone").toEqual(["room"]);

    await visit("#/ohbox");
    await waitFor(() => readerColumn() === null, "the plain place again");
    expect(owners(), "the plain place again: no seam").toEqual([]);
    expect(live.peak, "after every commit of the walk at most one seam was live").toBe(1);
  });

  it("a delete a closed tab left in the journal is replayed once, at the mount, on a reader's place too", async () => {
    const engine = engineOver(await storeWith([msg("m1")]));
    S.engine = engine;
    const replayed: string[] = [];
    const replay = engine.replayDelete.bind(engine);
    engine.replayDelete = (messageId, opts) => {
      replayed.push(messageId);
      return replay(messageId, opts);
    };
    armDeleteIntent({ id: "press-of-the-closed-tab", messageIds: ["m1"], at: Date.now() }, HARNESS_SCOPE);
    window.location.hash = "#/ohbox";
    await draw(engine);
    await waitFor(() => readerColumn() !== null, "the seated Ohbox's reading column");
    await waitFor(() => replayed.length > 0, "the journal's replay");
    await visit(TODAYS_ADDRESS);
    await waitFor(() => readerColumn() === null, "News");
    await visit("#/ohbox");
    await waitFor(() => readerColumn() !== null, "the seated Ohbox again");
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(replayed, "the journal was replayed by more than one seam, or again on the walk").toEqual(["m1"]);
  });
});
