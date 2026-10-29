/**
 * THE PHONE'S HALF OF "COULD NOT BE SAVED" — parity with the browser, asserted rather than assumed.
 *
 * The engine gives up on a verb after a bounded number of server-answered failures and moves it out
 * of the replay set. That bound is SHARED code, so it applies to this app whether or not it renders
 * anything — which is exactly why this file exists. A phone with no surface for it would drop a
 * person's work silently while the browser explained it, and nothing would fail: the engine would
 * be behaving correctly and the app would be quietly lying by omission.
 *
 * So the assertions here are about the two things a platform actually owes: a sentence for every
 * verb, and a door to both answers. The last block mounts the notice and presses it.
 */
import { createElement as h } from "react";
/* First: it answers the testing library's own `require("react-native")`. */
import { screen as device } from "./helpers/rn-host";
import { act, cleanupAsync, fireEvent, render, screen, type RenderResult } from "@testing-library/react-native/pure";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AbandonedMutation } from "@ohmail/client-engine";
import { MUTATION_KINDS } from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { describeKind, reason, retrySaid } from "../src/ui/unsaved-copy";
import { ThemeProvider } from "../src/theme";
import { UnsavedChanges } from "../src/ui/UnsavedChanges";

vi.mock("react-native", () => import("./helpers/rn-host"));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("react-native-svg", () => ({ default: () => null, Circle: () => null, Path: () => null, Rect: () => null }));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
const world = vi.hoisted(() => ({ abandoned: [] as unknown[], queued: [] as unknown[], actions: {} as Record<string, unknown> }));
vi.mock("../src/state/world", () => ({ useWorld: () => world }));

const row = (kind: string, error: Partial<AbandonedMutation["error"]> = {}): AbandonedMutation => ({
  id: `id-${kind}`,
  key: `key-${kind}`,
  mutation: { kind } as never,
  at: 1,
  attempts: 8,
  error: { message: "nope", code: "conflict", status: 409, ...error },
  superseded: false,
  retryable: true,
  refusedCode: null,
});

describe("every verb the engine can abandon has words on the phone", () => {
  it("names each shipped mutation kind, and never shows a raw kind", () => {
    // Derived from `MUTATION_KINDS` — the shipped list, not a copy — so a verb added later is
    // covered by this assertion the day it lands rather than the day somebody remembers.
    const unnamed: string[] = [];
    for (const kind of MUTATION_KINDS) {
      const label = describeKind(row(kind));
      // The failure this catches is not a missing translation; it is `folder_op_dismiss` appearing
      // on screen in front of a person trying to understand why their mail did not send.
      if (label.includes("_")) unnamed.push(`${kind} → ${label}`);
      expect(label.length, kind).toBeGreaterThan(0);
    }
    expect(unnamed).toEqual([]);
  });

  it("degrades to a generic sentence for a kind it has no words for, rather than throwing", () => {
    // The web half's identical guard: a computed lookup would throw here, inside the one surface
    // that only renders when something has already gone wrong.
    expect(describeKind(row("verb_added_next_tuesday"))).toBe(Copy.unsavedKindOther);
  });
});

describe("what the phone says about WHY, and what it refuses to repeat", () => {
  it("quotes a refusal a person can act on", () => {
    expect(reason(row("move", { message: "that folder is gone", code: "not_found", status: 404 })))
      .toBe("that folder is gone");
  });

  it("never quotes the unhandled-fault envelope", () => {
    // `{"code":"internal","message":"internal error"}` is the API's envelope for a throw nobody
    // modelled. Repeating it puts the app's own noise in front of a person.
    expect(reason(row("mail_send", { message: "internal error", code: "internal", status: 500 })))
      .toBe(Copy.unsavedNoReason);
    // A blank sentence is the same failure with fewer characters.
    expect(reason(row("mail_send", { message: "   ", code: "weird", status: 500 })))
      .toBe(Copy.unsavedNoReason);
    // …and an adapter-side rejection that carried no code at all.
    expect(reason(row("mail_send", { message: "boom", code: null, status: null })))
      .toBe(Copy.unsavedNoReason);
  });
});

describe("the phone and the browser say the same words", () => {
  it("uses the same sentences as the web copy for every shared key", async () => {
    // PARITY IS A RULE (mobile/web), and copy is where it rots first: one platform gets a reword,
    // the other keeps the old sentence, and a person who uses both learns two names for one state.
    // Read from the web's message catalogue rather than restated here, so a change on either side
    // has to be a change on both.
    const web = (await import("../../webapp/messages/en.json")).default.sync as Record<string, string>;

    expect(Copy.unsavedShow).toBe(web.unsavedShow);
    expect(Copy.unsavedHide).toBe(web.unsavedHide);
    expect(Copy.unsavedRetry).toBe(web.unsavedRetry);
    expect(Copy.unsavedDiscard).toBe(web.unsavedDiscard);
    expect(Copy.unsavedNoReason).toBe(web.unsavedNoReason);
    expect(Copy.unsavedKindOther).toBe(web.unsavedKindOther);
    expect(Copy.unsavedKindSend).toBe(web.unsavedKindSend);
    expect(Copy.unsavedKindMove).toBe(web.unsavedKindMove);
    expect(Copy.unsavedKindRead).toBe(web.unsavedKindRead);

    // The count is a plural on the web and a function here; the rendered strings must still match.
    expect(Copy.unsavedCount(1)).toBe("1 change could not be saved");
    expect(Copy.unsavedCount(3)).toBe("3 changes could not be saved");
    expect(web.unsavedCount).toContain("change could not be saved");
    expect(web.unsavedCount).toContain("changes could not be saved");
  });
});

describe("I7 — every surface that can abandon work can show it", () => {
  it("the chrome renders the notice on the pushed screens, not only the tab roots", async () => {
    // A verb can be abandoned from the message, sender, triage, scheduled, folder, settings and
    // server screens — all of which render `DetailBar`. Until this, the notice appeared nowhere
    // until the reader navigated back to a tab root: a recovery surface found by accident.
    const { readFileSync } = await import("node:fs");
    const chrome = readFileSync(new URL("../src/ui/chrome.tsx", import.meta.url), "utf8");
    const detail = chrome.slice(chrome.indexOf("export function DetailBar"));
    const top = chrome.slice(chrome.indexOf("export function TopBar"), chrome.indexOf("export function DetailBar"));
    expect(top, "TopBar must render it").toContain("<UnsavedChanges />");
    expect(detail, "DetailBar must render it too").toContain("<UnsavedChanges />");
  });

  it("a send retried from the strip whose key had already delivered says so", () => {
    expect(retrySaid({ status: "confirmed", firstSend: { status: "sent", at: "x" } })).toBe(Copy.unsavedSendAlreadyWent);
    expect(retrySaid({ status: "confirmed" }), "CONTROL: an ordinary confirmation says nothing").toBeNull();
  });
});

describe("the notice, mounted", () => {
  afterEach(async () => {
    await cleanupAsync();
    Object.assign(device, { width: 400, height: 800 });
  });
  const notice = () => h(ThemeProvider, { pref: "light", children: h(UnsavedChanges) });
  const mount = (rows: AbandonedMutation[], actions: Record<string, unknown> = {}): RenderResult => {
    Object.assign(world, { abandoned: rows, queued: [], actions });
    return render(notice());
  };
  const shown = () => fireEvent.press(screen.getByText(`${Copy.unsavedCount(world.abandoned.length)} · ${Copy.unsavedShow}`));
  /** The host elements above a node, nearest first. */
  type Host = { type: unknown; props: { style?: Record<string, unknown> }; parent: Host | null };
  const above = (node: unknown): Host[] => {
    const out: Host[] = [];
    for (let n = (node as Host).parent; n; n = n.parent) if (typeof n.type === "string") out.push(n);
    return out;
  };
  const rowOf = (label: string) => above(screen.getByText(label)).find((n) => n.props.style?.flexDirection)?.props.style;

  it("renders, and says the count only while there is something to say", () => {
    const empty = mount([]);
    expect(screen.queryByText(/could not be saved/)).toBeNull();
    empty.unmount();
    mount([row("move"), row("mail_send")]);
    expect(screen.getByText(`${Copy.unsavedCount(2)} · ${Copy.unsavedShow}`)).toBeTruthy();
  });

  /* The strip stands under the top bar; its press target grown upward took the Sidebar button's
     presses, so in two panes the Sidebar only toggled "Show them". */
  it("the strip's toggle reaches down and sideways, never up over the bar above it", () => {
    mount([row("move")]);
    const slopOf = (label: string) =>
      (above(screen.getByText(label)).find((n) => (n.props as { hitSlop?: unknown }).hitSlop !== undefined)?.props as { hitSlop?: unknown })?.hitSlop;
    const slop = slopOf(`${Copy.unsavedCount(1)} · ${Copy.unsavedShow}`) as { top: number; bottom: number; left: number };
    expect(slop.top, "a press above the strip belongs to the bar").toBe(0);
    expect(slop.bottom, "CONTROL: the target still grows below").toBeGreaterThan(0);
    expect(slop.left).toBeGreaterThan(0);
  });

  it("Try again and Discard sit inside the bounded scroller, and stack below 380 dp", () => {
    device.width = 360;
    const narrow = mount([row("move")]);
    shown();
    for (const label of [Copy.unsavedRetry, Copy.unsavedDiscard]) {
      const scroller = above(screen.getByText(label)).find((n) => n.type === "RCTScrollView");
      expect(scroller, `${label} is outside the scroller`).toBeDefined();
      expect(scroller!.props.style).toMatchObject({ maxHeight: Math.round(800 / 3) });
      expect(rowOf(label)).toMatchObject({ flexDirection: "column" });
    }
    narrow.unmount();
    device.width = 400;
    mount([row("move")]);
    shown();
    expect(rowOf(Copy.unsavedRetry), "CONTROL: a wide screen keeps them on one row").toMatchObject({ flexDirection: "row" });
  });

  it("pressing Try again and Discard asks the engine for that change", async () => {
    const retryAbandoned = vi.fn(async () => ({ status: "confirmed" }));
    const discardAbandoned = vi.fn(async () => undefined);
    mount([row("move")], { retryAbandoned, discardAbandoned });
    shown();
    await act(async () => { fireEvent.press(screen.getByText(Copy.unsavedRetry)); });
    expect(retryAbandoned).toHaveBeenCalledWith("id-move");
    await act(async () => { fireEvent.press(screen.getByText(Copy.unsavedDiscard)); });
    expect(discardAbandoned).toHaveBeenCalledWith("id-move");
  });

  it("a terminal answer to the last row stays on screen after the row is gone", async () => {
    const retryAbandoned = vi.fn(async () => {
      world.abandoned = [];
      return { status: "rolled_back", error: { code: "send_unverified", message: "It may have gone. Check Sent." } };
    });
    const view = mount([row("mail_send")], { retryAbandoned });
    shown();
    await act(async () => { fireEvent.press(screen.getByText(Copy.unsavedRetry)); });
    view.rerender(notice());
    expect(screen.getByText(`It may have gone. Check Sent. · ${Copy.unsavedDismiss}`)).toBeTruthy();
    expect(screen.queryByText(Copy.unsavedRetry), "CONTROL: the row itself is gone").toBeNull();
  });
});
