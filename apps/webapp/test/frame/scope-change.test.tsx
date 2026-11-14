/** @vitest-environment jsdom */
/**
 * A HALF-WRITTEN LETTER STAYS IN ITS OWN PARTITION. Under scope A a letter is begun; the host now names scope B (the
 * storage owner and the scope change together, as every entry changes them). The frame is mounted again, so B's composer is
 * empty, nothing B sends carries A's words, and A's letter is there when A returns. The frame's `Scoped` key is what
 * holds it: without it today's composer keeps A's words in its state under B's partition (seen red so).
 */
import { createElement as h, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE } from "@ohmail/app/host";
import { TextProvider } from "@ohmail/app/text";
import { setStorageOwner, resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import type { OhmailEngine } from "@ohmail/client-engine";
import messages from "../../messages/en.json";
import { act, engineOver, NOW, setup, storeWith, teardown, waitFor, S } from "../_view-shell";
import { hostFromTodaysInputs } from "../_todays-shell";

const A = "acct-aaaa";
const B = "acct-bbbb";
const WORDS = "Half a letter for A";

let root: Root | null = null;

/** The modules a mount needs, loaded once: an entry's component keeps one identity across renders, as a real one does. */
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
 * As an entry builds it: the host names the scope, and the frame under it is keyed by it. Declared once, at module
 * scope: were it made inside each draw, React would see a new component type on every render and mount the whole
 * tree again whatever the frame does, and this test would hold nothing.
 */
function Entry({ engine, scope }: { engine: OhmailEngine; scope: string }) {
  const { TodaysFrame, NO_TODAYS, useTodaysSupplies } = parts!;
  const frame = useTodaysSupplies(NONE);
  const host = useMemo(() => {
    const made = hostFromTodaysInputs({ demo: false, engine }, engine, frame, NONE);
    return { ...made, session: { ...made.session, scope } };
  }, [engine, frame, scope]);
  return h(TodaysFrame, { host, todays: NO_TODAYS });
}

async function draw(engine: OhmailEngine, scope: string) {
  parts ??= await loaded();
  const { ThemeProvider, ToastHost, EngineProvider } = parts;
  const tree = h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW } as never,
    h(TextProvider, { locale: "en", messages: messages as never, timeZone: "UTC" } as never,
      h(ThemeProvider as never, null, h(ToastHost as never, null,
        h(EngineProvider, { demo: false, engine } as never, h(Entry, { engine, scope }))))));
  if (root === null) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => { root!.render(tree); });
}

const subject = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('input[aria-label="Subject"]');

beforeEach(() => {
  setup();
  resetStorageOwnerForTest();
  window.location.hash = "#/compose";
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  resetStorageOwnerForTest();
  await teardown();
});

describe("a change of scope", () => {
  it("mounts the frame again: B's composer is empty, nothing under B carries A's words, A's letter is back", async () => {
    const engine = engineOver(await storeWith([]));
    S.engine = engine;
    const sent: Array<{ owner: string; words: string }> = [];
    let owner = A;
    const mutate = engine.mutate.bind(engine);
    vi.spyOn(engine, "mutate").mockImplementation(((m: unknown, ...rest: unknown[]) => {
      sent.push({ owner, words: JSON.stringify(m) });
      return (mutate as (...a: unknown[]) => unknown)(m, ...rest);
    }) as never);

    setStorageOwner(A);
    await draw(engine, A);
    await waitFor(() => subject() !== null, "the composer under A");
    await act(async () => { fireEvent.change(subject()!, { target: { value: WORDS } }); });
    await waitFor(() => Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? "").includes(WORDS)), "A's words kept on this device");

    owner = B;
    setStorageOwner(B);
    await draw(engine, B);
    await waitFor(() => subject() !== null, "the composer under B");
    expect(subject()!.value).toBe("");
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(sent.filter((s) => s.owner === B && s.words.includes(WORDS))).toEqual([]);

    owner = A;
    setStorageOwner(A);
    await draw(engine, A);
    await waitFor(() => subject()?.value === WORDS, "A's letter back under A");
  });
});
