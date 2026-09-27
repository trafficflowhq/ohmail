/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import type { MailboxFacts } from "../../webapp/app/shell/mail-state";

/**
 * "ACT ON CONFIDENT SUGGESTIONS FOR ME" ON BOTH DESKTOP DOORS. Standalone: the pane
 * draws it under "Suggest for new senders automatically" over the engine's own consent route, and
 * a reader install shows it disabled with the organizer sentence. Hosted: the shared shell's row
 * over the bridge, as `AppShell` composes it. Real components over a scripted engine.
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

const ORGANIZER: MailboxFacts = {
  id: "mbx-1", address: "someone@example.test", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-02T09:00:00.000Z", initialImportCompletedAt: "2026-09-02T09:00:00.000Z",
  createdAt: "2026-09-01T09:00:00.000Z", organizerRole: "organizer", organizedBy: null,
  organizerState: null, organizeConsentedAt: "2026-09-01T09:00:00.000Z",
};
const READER: MailboxFacts = {
  ...ORGANIZER, organizerRole: "reader",
  organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-09-02T08:00:00.000Z" },
  organizerState: "held", organizeConsentedAt: null,
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

/** The engine's stored answers; the scripted routes read and write these. */
let suggestOn: boolean;
let actAt: string | null;
/** False ⇒ an engine from before the act had a switch: `GET /consent` carries no `autoActAt`. */
let carriesAxis: boolean;
let asked: Array<{ method: string; url: string; body?: string }>;
const AT = "2026-09-27T08:00:00.000Z";

function engine(): void {
  shellHost.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command !== "engine_request") return null;
      const method = String(payload?.method ?? "GET");
      const url = String(payload?.url ?? "");
      const bytes = Uint8Array.from((payload?.body as number[]) ?? []);
      const body = bytes.byteLength > 0 ? new TextDecoder().decode(bytes) : undefined;
      asked.push({ method, url, ...(body ? { body } : {}) });
      const said = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      if (url === "/local/auto-suggest") {
        if (method === "PUT") {
          suggestOn = said.on === true;
          if (!suggestOn) actAt = null;
        }
        return encode(200, JSON.stringify({ on: suggestOn, since: suggestOn ? AT : null, modelReady: true }));
      }
      if (url === "/consent") {
        return encode(200, JSON.stringify({
          seedConfirmedAt: AT, screeningResetAt: null, dormancyDays: 60, screeningBaselineAt: null,
          autoSuggestAt: suggestOn ? AT : null, ...(carriesAxis ? { autoActAt: actAt } : {}),
        }));
      }
      if (url === "/consent/settings" && method === "PATCH") {
        if ("autoAct" in said) {
          if (said.autoAct === true && !suggestOn) {
            return encode(400, JSON.stringify({ error: { code: "auto_suggest_required", message: "needs suggestions" } }));
          }
          actAt = said.autoAct === true ? AT : null;
          return encode(200, JSON.stringify({ autoActAt: actAt }));
        }
        if ("autoSuggest" in said) {
          suggestOn = said.autoSuggest === true;
          if (!suggestOn) actAt = null;
          return encode(200, JSON.stringify({
            autoSuggestAt: suggestOn ? AT : null, ...(suggestOn ? {} : { autoActAt: null }),
          }));
        }
        return encode(200, "{}");
      }
      return encode(200, JSON.stringify({
        ohboxPolicy: "people_and_replied", ohboxBar: null, defaultBar: "x", screenerAutoApply: false,
      }));
    },
  };
}

let hostEl: HTMLDivElement;
let root: Root | null = null;
const settle = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
};

async function mountPane(facts: MailboxFacts[]): Promise<void> {
  FACTS = facts;
  const { DesktopScreening } = await import("../src/DesktopScreening.js");
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, timeZone: "UTC", children: h(DesktopScreening, { door: "local" }),
    }));
  });
  await settle();
}

const switchNamed = (label: string): HTMLButtonElement | null =>
  hostEl.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);
const ACT = en.screener.suggest.actTitle;
const SUGGEST = en.desktopScreener.autoSuggestLabel;

beforeEach(() => {
  suggestOn = true; actAt = null; carriesAxis = true; asked = [];
  engine();
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  hostEl?.remove();
  delete shellHost.__TAURI_INTERNALS__;
});

describe("the standalone door: the act's switch under automatic suggestions", () => {
  it("renders directly under the suggest switch and writes the act over the engine's consent route", async () => {
    await mountPane([ORGANIZER]);
    const switches = [...hostEl.querySelectorAll('button[role="switch"]')].map((b) => b.getAttribute("aria-label"));
    expect(switches.indexOf(ACT), "the act's switch is not drawn").toBeGreaterThan(-1);
    expect(switches.indexOf(ACT), "the act's switch is not directly under the suggest switch")
      .toBe(switches.indexOf(SUGGEST) + 1);
    expect(hostEl.textContent).toContain(en.screener.suggest.actDescription);
    expect(switchNamed(ACT)!.disabled).toBe(false);

    await act(async () => { switchNamed(ACT)!.click(); });
    await settle();
    const write = asked.find((a) => a.method === "PATCH" && a.url === "/consent/settings");
    expect(write?.body).toBe(JSON.stringify({ autoAct: true }));
    expect(switchNamed(ACT)!.getAttribute("aria-checked")).toBe("true");
  });

  it("is disabled with 'Needs automatic suggestions' while those are off, and turning them off withdraws it", async () => {
    actAt = AT;
    await mountPane([ORGANIZER]);
    expect(switchNamed(ACT)!.getAttribute("aria-checked")).toBe("true");
    await act(async () => { switchNamed(SUGGEST)!.click(); });
    await settle();
    expect(switchNamed(ACT)!.getAttribute("aria-checked"), "suggestions off left the act on").toBe("false");
    expect(switchNamed(ACT)!.disabled).toBe(true);
    expect(hostEl.textContent).toContain(en.screener.suggest.actNeedsSuggest);
  });

  it("on a reader install it is disabled and sends the person to the organizer", async () => {
    await mountPane([READER]);
    expect(switchNamed(ACT)!.disabled).toBe(true);
    expect(hostEl.textContent).toContain("Set this on the install that organizes your mail.");
  });

  it("CONTROL: an install that organizes gets no reader sentence", async () => {
    await mountPane([ORGANIZER]);
    expect(hostEl.textContent).not.toContain(en.screener.suggest.actReader);
  });

  it("an engine whose consent answer carries no such setting draws no switch", async () => {
    carriesAxis = false;
    await mountPane([ORGANIZER]);
    expect(switchNamed(SUGGEST)).not.toBeNull();
    expect(switchNamed(ACT)).toBeNull();
  });
});

describe("the hosted door: the shared shell's row over the bridge", () => {
  it("reads the act off the account's consent and writes it through the engine's forward", async () => {
    const { useConsentState } = await import("../../webapp/app/shell/consent-state");
    const { AutoActRow } = await import("../../webapp/app/shell/AutoActRow");
    const { consentOverBridge } = await import("../src/local-consent.js");
    /* `AppShell`'s own composition of the row, and nothing else of it. */
    function Harness() {
      const consent = useConsentState(true, consentOverBridge);
      return consent.autoActStorable && consent.setAutoAct
        ? h(AutoActRow, { on: consent.autoAct, suggestOn: consent.autoSuggest, reader: false, setAutoAct: consent.setAutoAct })
        : null;
    }
    hostEl = document.createElement("div");
    document.body.append(hostEl);
    root = createRoot(hostEl);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages: en as never, timeZone: "UTC", children: h(Harness) }));
    });
    await settle();
    expect(switchNamed(ACT), "the hosted door drew no act switch").not.toBeNull();
    await act(async () => { switchNamed(ACT)!.click(); });
    await settle();
    expect(asked.filter((a) => a.method === "PATCH").map((a) => a.body)).toEqual([JSON.stringify({ autoAct: true })]);
    expect(switchNamed(ACT)!.getAttribute("aria-checked")).toBe("true");
  });

  it("turning automatic suggestions off withdraws the act in the shell's own state", async () => {
    actAt = AT;
    const { useConsentState } = await import("../../webapp/app/shell/consent-state");
    const { AutoActRow } = await import("../../webapp/app/shell/AutoActRow");
    const { consentOverBridge } = await import("../src/local-consent.js");
    function Harness() {
      const consent = useConsentState(true, consentOverBridge);
      return h("div", null,
        h("button", { className: "suggest-off", onClick: () => { void consent.setAutoSuggest(false); } }, "off"),
        consent.autoActStorable && consent.setAutoAct
          ? h(AutoActRow, { on: consent.autoAct, suggestOn: consent.autoSuggest, reader: false, setAutoAct: consent.setAutoAct })
          : null);
    }
    hostEl = document.createElement("div");
    document.body.append(hostEl);
    root = createRoot(hostEl);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages: en as never, timeZone: "UTC", children: h(Harness) }));
    });
    await settle();
    expect(switchNamed(ACT)!.getAttribute("aria-checked")).toBe("true");
    await act(async () => { hostEl.querySelector<HTMLButtonElement>(".suggest-off")!.click(); });
    await settle();
    expect(switchNamed(ACT)!.getAttribute("aria-checked"), "the shell kept the act on after suggestions went off").toBe("false");
    expect(switchNamed(ACT)!.disabled).toBe(true);
  });
});
