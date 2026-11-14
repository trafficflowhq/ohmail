/** @vitest-environment jsdom */
/**
 * A CHANGE OF SCOPE LEAVES NOTHING OF THE OHBOX BEFORE IT. Under scope A a row is picked and another is open (the
 * engine holds it in New); the host now names scope B with B's engine. B's Ohbox shows B's letters only, no pick
 * stands, and B's engine holds no row: the Ohbox's model lives under the frame's `Scoped`, never above it.
 */
import { createElement as h, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NONE } from "@ohmail/app/host";
import { TextProvider } from "@ohmail/app/text";
import { setStorageOwner, resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import type { OhmailEngine } from "@ohmail/client-engine";
import messages from "../../messages/en.json";
import { act, click, consentTransport, engineOver, msg, NOW, setup, storeWith, teardown, waitFor } from "../_view-shell";
import { hostFromTodaysInputs } from "../_todays-shell";
import { ohboxRow, ohboxRows, pickedCount } from "./_today";

const A = "acct-aaaa";
const B = "acct-bbbb";
const ROSTER = async () => [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const, organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

let root: Root | null = null;

type Mods = {
  ui: typeof import("@ohmail/ui");
  engine: typeof import("../../app/shell/engine");
  frame: typeof import("../../app/shell/TodaysFrame");
  inputs: typeof import("../../app/shell/todays-inputs");
  supplies: typeof import("../../app/shell/todays-supplies");
};
let mods: Mods | null = null;

/* As an entry builds it: the host names the scope and its engine, and the frame under it is keyed by the scope.
   One component for every draw, so only the frame's own key can end what stood under the scope before. */
function Scoped({ scope: named, engine: shown }: { scope: string; engine: OhmailEngine }) {
  const m = mods!;
  const frame = m.supplies.useTodaysSupplies(NONE);
  const host = useMemo(() => {
    const made = hostFromTodaysInputs({ demo: false, engine: shown, consentTransport, mailboxFacts: ROSTER } as never, shown, frame, NONE);
    return { ...made, session: { ...made.session, scope: named } };
  }, [frame, named, shown]);
  return h(m.frame.TodaysFrame, { host, todays: m.inputs.NO_TODAYS });
}

async function draw(engine: OhmailEngine, scope: string) {
  mods ??= {
    ui: await import("@ohmail/ui"),
    engine: await import("../../app/shell/engine"),
    frame: await import("../../app/shell/TodaysFrame"),
    inputs: await import("../../app/shell/todays-inputs"),
    supplies: await import("../../app/shell/todays-supplies"),
  };
  const { ThemeProvider, ToastHost } = mods.ui;
  const { EngineProvider } = mods.engine;
  const tree = h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW } as never,
    h(TextProvider, { locale: "en", messages: messages as never, timeZone: "UTC" } as never,
      h(ThemeProvider as never, null, h(ToastHost as never, null,
        h(EngineProvider, { demo: false, engine } as never, h(Scoped, { scope, engine }))))));
  if (root === null) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => { root!.render(tree); });
}

const ids = (): string[] => ohboxRows(document.body).map((r) => r.dataset.id!);

beforeEach(() => {
  setup();
  resetStorageOwnerForTest();
  window.location.hash = "#/ohbox";
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  resetStorageOwnerForTest();
  await teardown();
});

describe("a change of scope", () => {
  it("leaves no row, no pick and no held row of the scope before", async () => {
    const at = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
    const a = engineOver(await storeWith([
      msg("a1", { unread: true, date: at(10), updatedAt: at(10) }),
      msg("a2", { unread: true, date: at(20), updatedAt: at(20) }),
      msg("a3", { unread: true, date: at(30), updatedAt: at(30) }),
    ]));
    /* B carries a letter of the same id as A's pick: only the scope, never the ids, can end that pick. */
    const b = engineOver(await storeWith([
      msg("b1", { unread: true, date: at(5), updatedAt: at(5) }),
      msg("a1", { unread: true, date: at(10), updatedAt: at(10) }),
    ]));

    setStorageOwner(A);
    await draw(a, A);
    await waitFor(() => ids().length === 3, "A's three rows");
    // Pick a1 (⌘-click), then open a2: the engine holds it in New.
    await act(async () => {
      ohboxRow(document.body, "a1")!.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true, ctrlKey: true }));
    });
    await click(ohboxRow(document.body, "a2"), "a2's row");
    await waitFor(() => pickedCount(document.body) === "1", "A's pick");
    await waitFor(() => a.openRowHeld() === "a2", "A's open row held");

    setStorageOwner(B);
    await draw(b, B);
    await waitFor(() => ids().length > 0, "B's rows");
    await waitFor(() => ids().length === 2, "B's two rows");
    expect(ids()).toEqual(["b1", "a1"]);
    expect(pickedCount(document.body), "a pick of A stands under B").toBeNull();
    expect(b.openRowHeld(), "B's engine holds a row nobody opened").toBeNull();
    expect(document.querySelector("[role=option][data-open]"), "a row stands open under B").toBeNull();
  });

  it("with the same engine handed on, the frame's scope alone ends the pick", async () => {
    const at = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
    const one = engineOver(await storeWith([
      msg("a1", { unread: true, date: at(10), updatedAt: at(10) }),
      msg("a2", { unread: true, date: at(20), updatedAt: at(20) }),
    ]));
    setStorageOwner(A);
    await draw(one, A);
    await waitFor(() => ids().length === 2, "A's two rows");
    await act(async () => {
      ohboxRow(document.body, "a1")!.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true, ctrlKey: true }));
    });
    await click(ohboxRow(document.body, "a2"), "a2's row");
    await waitFor(() => pickedCount(document.body) === "1", "A's pick");

    setStorageOwner(B);
    await draw(one, B);
    await waitFor(() => ids().length === 2, "the rows under B");
    expect(pickedCount(document.body), "a pick of A stands under B").toBeNull();
  });
});
