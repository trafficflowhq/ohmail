/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import type { MailboxFacts } from "../../webapp/app/shell/mail-state";

/**
 * A SCREENING CHANGE MADE ON A READER SAYS WHERE IT WENT, on both desktop doors. Both reach
 * `/account/screening` over the engine pipe — the standalone engine answers it, the hosted one
 * forwards it — so the pane is driven over a scripted engine answering as a reader's server does.
 * The switches used to snap back with nothing said, and the words said "Saved.".
 */

let FACTS: MailboxFacts[] | null = null;
vi.mock("../../webapp/app/shell/MailStateProvider", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/shell/MailStateProvider")>(
    "../../webapp/app/shell/MailStateProvider",
  );
  return { ...real, useMailboxFacts: () => FACTS };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

const READER: MailboxFacts = {
  id: "mbx-1", address: "someone@example.test", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-02T09:00:00.000Z", initialImportCompletedAt: "2026-09-02T09:00:00.000Z",
  createdAt: "2026-09-01T09:00:00.000Z", organizerRole: "reader",
  organizedBy: { kind: "local", name: "work-laptop", since: "2026-09-02T08:00:00.000Z" },
  organizerState: "held", organizeConsentedAt: null, organizerAcceptsRequests: true,
};

function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const shellHost = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };

type Change = { state: "asked" | "applied" | "refused"; holder: string | null; refusal: "unreadable" | "other" | null };
const STORED = { ohboxPolicy: "people_and_replied", ohboxBar: null, defaultBar: "Keep it for people.", screenerAutoApply: false };
let answer: { change?: Change; applied?: Record<string, unknown> };

function engine(): void {
  shellHost.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command !== "engine_request") return null;
      const url = String(payload?.url ?? "");
      const method = String(payload?.method ?? "GET");
      if (url === "/local/auto-suggest") return encode(404, "{}");
      if (url === "/consent") return encode(404, "{}");
      if (url !== "/account/screening") return encode(404, "{}");
      const read = { ...STORED, ...(answer.applied ?? {}), ...(answer.change ? { change: answer.change } : {}) };
      if (method !== "PATCH") return encode(200, JSON.stringify(read));
      answer = { ...answer, change: { state: "asked", holder: null, refusal: null } };
      return encode(200, JSON.stringify({ ...read, change: answer.change, pending: true }));
    },
  };
}

const S = en.settings.screening;
/** The away row's sentence for the same state — the one the pane reuses. */
const ASKED = en.away.asked;
const D = en.desktopScreener;
let hostEl: HTMLDivElement;
let root: Root | null = null;
const settle = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
};
const poll = async (): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  await settle();
};

async function mountPane(door: "local" | "cloud"): Promise<void> {
  const { DesktopScreening } = await import("../src/DesktopScreening.js");
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, timeZone: "UTC", children: h(DesktopScreening, { door }),
    }));
  });
  await settle();
}

const posture = (): HTMLButtonElement =>
  hostEl.querySelector(`button[role="switch"][aria-label="${D.postureLabel}"]`) as HTMLButtonElement;
const text = (): string => hostEl.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  FACTS = [READER];
  answer = {};
  engine();
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  hostEl?.remove();
  delete shellHost.__TAURI_INTERNALS__;
  vi.useRealTimers();
});

describe.each(["local", "cloud"] as const)("the %s door on a reader", (door) => {
  it("says the change was sent, then Applied. over the value the holder applied", async () => {
    await mountPane(door);
    expect(text()).toContain(D.readerNote.replace("{name}", "work-laptop"));
    await act(async () => { posture().click(); });
    await settle();
    expect(text(), "the switch snapped back with nothing said").toContain(ASKED);
    expect(posture().getAttribute("aria-checked")).toBe("false");

    answer = { change: { state: "applied", holder: null, refusal: null }, applied: { ohboxPolicy: "people_only" } };
    await poll();
    expect(text()).toContain(S.applied);
    expect(posture().getAttribute("aria-checked")).toBe("true");
  });

  it("names the holder that could not read the change", async () => {
    await mountPane(door);
    await act(async () => { posture().click(); });
    await settle();
    answer = { change: { state: "refused", holder: "work-laptop", refusal: "unreadable" } };
    await poll();
    expect(text()).toContain(S.refusedUnreadable.replace("{name}", "work-laptop"));
  });

  it("the words say nothing of their own when the save travelled, and the pane says it once", async () => {
    await mountPane(door);
    const box = hostEl.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(box, "People I know."); box.dispatchEvent(new Event("input", { bubbles: true })); });
    await settle();
    const save = [...hostEl.querySelectorAll("button")].find((b) => b.textContent?.trim() === S.save)!;
    await act(async () => { save.click(); });
    await settle();
    expect(text()).not.toContain(S.saved);
    expect(text().split(ASKED).length - 1).toBe(1);
    answer = { change: { state: "applied", holder: null, refusal: null }, applied: { ohboxBar: "People I know." } };
    await poll();
    expect((hostEl.querySelector("textarea") as HTMLTextAreaElement).value).toBe("People I know.");
  });
});

describe("the hosted door's act switch", () => {
  it("does not promise the Rules group its copy of the rules cannot show", () => {
    const gate = readFileSync(resolve(process.cwd(), "apps/desktop/src/DesktopGate.tsx"), "utf8");
    expect(gate).toMatch(/status\?\.mode === "cloud" \? \{ actRulesUnmarked: true \}/);
    const shell = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/AppShell.tsx"), "utf8");
    expect(shell).toMatch(/rulesMarked=\{!actRulesUnmarked\}/);
  });
});
