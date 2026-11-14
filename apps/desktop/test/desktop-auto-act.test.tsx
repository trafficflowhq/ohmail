/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor, within } from "@testing-library/react";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { DesktopGate } from "../src/DesktopGate.js";
import { CLOUD_URL } from "../src/doors.js";
import { IntlProvider } from "use-intl";

import en from "../../webapp/messages/en.json";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * "ACT ON CONFIDENT SUGGESTIONS FOR ME" ON BOTH DESKTOP DOORS. Standalone: the pane
 * draws it under "Suggest for new senders automatically" over the engine's own consent route, and
 * a reader install shows it disabled with the organizer sentence. Hosted: the shared shell's row
 * through the same Settings route, over a scripted engine.
 */

let FACTS: MailboxFacts[] | null = null;
vi.mock("@ohmail/app-logic/mail-state/mail-state-binding", async () => {
  const real = await vi.importActual<typeof import("@ohmail/app-logic/mail-state/mail-state-binding")>(
    "@ohmail/app-logic/mail-state/mail-state-binding",
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
window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
})) as typeof window.matchMedia;

const shellHost = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };

/** The engine's stored answers; the scripted routes read and write these. */
let suggestOn: boolean;
let actAt: string | null;
/** False ⇒ an engine from before the act had a switch: `GET /consent` carries no `autoActAt`. */
let carriesAxis: boolean;
let asked: Array<{ method: string; url: string; body?: string }>;
/** The account's auto-apply and AI switches, as another device may have left them. */
let peopleOnly: boolean;
let aiOn: boolean;
let pendingAiWrite: Promise<number> | undefined;
let aiRead: "valid" | "offline" | "malformed";
/** The impersonation filing switch the engine answers with; `undefined`: an engine from before it. */
let impersonationOn: boolean | undefined;
const AT = "2026-09-27T08:00:00.000Z";

let engineDoor: "local" | "cloud" = "local";

function engine(): void {
  shellHost.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command === "engine_status") return {
        state: "serving", mode: engineDoor, credentialState: "ready",
        mailboxId: ORGANIZER.id, address: ORGANIZER.address,
        cloudUrl: engineDoor === "cloud" ? CLOUD_URL : undefined,
      };
      if (command !== "engine_request") return null;
      const method = String(payload?.method ?? "GET");
      const url = String(payload?.url ?? "");
      const bytes = Uint8Array.from((payload?.body as number[]) ?? []);
      const body = bytes.byteLength > 0 ? new TextDecoder().decode(bytes) : undefined;
      asked.push({ method, url, ...(body ? { body } : {}) });
      const said = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      if (url === "/health") return encode(200, '{"signedIn":true}');
      if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: FACTS }));
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
      if (url === "/account/ai") {
        if (method === "PATCH" && pendingAiWrite) {
          const status = await pendingAiWrite;
          return encode(status, JSON.stringify({ aiEnabled: said.aiEnabled }));
        }
        if (aiRead === "offline") return encode(503, "{}");
        if (aiRead === "malformed") return encode(200, "{}");
        return encode(200, JSON.stringify({ aiEnabled: aiOn }));
      }
      if (url === "/account/screening" && method === "PATCH" && typeof said.impersonationFiling === "boolean") {
        impersonationOn = said.impersonationFiling;
      }
      return encode(200, JSON.stringify({
        ohboxPolicy: peopleOnly ? "people_only" : "people_and_replied", ohboxBar: null, defaultBar: "x",        ...(impersonationOn === undefined ? {} : { impersonationFiling: impersonationOn }),
      }));
    },
  };
}

let hostEl: HTMLDivElement;
let root: Root | null = null;
const settle = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
};

async function mountPane(
  facts: MailboxFacts[], door: "local" | "cloud" = "local", section: "screener" | "ai" = "screener",
): Promise<void> {
  FACTS = facts;
  engineDoor = door;
  window.location.hash = `#/settings/${section}`;
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(IntlProvider, {
      locale: "en", messages: en as never, timeZone: "UTC",
      children: h(ThemeProvider, { children: h(ToastHost, { children: h(DesktopGate) }) }),
    }));
  });
  await within(hostEl).findByRole("region", { name: en.settings[section] });
  const label = section === "ai" ? en.settings.aiLabel : en.desktopScreener.postureLabel;
  await waitFor(() => expect(switchNamed(label)?.disabled).toBe(false));
  await settle();
}

async function closePane() {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  hostEl?.remove();
  window.location.hash = "";
}

const switchNamed = (label: string): HTMLButtonElement | null =>
  hostEl.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);
const ACT = en.screener.suggest.actTitle;
const SUGGEST = en.desktopScreener.autoSuggestLabel;

beforeEach(() => {
  suggestOn = true; actAt = null; carriesAxis = true; asked = []; peopleOnly = false; aiOn = true; aiRead = "valid"; impersonationOn = undefined;
  engine();
});
afterEach(async () => {
  await closePane();
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

describe("filing a held impersonation to Spam, on both desktop doors", () => {
  const IMPERSONATION = en.desktopScreener.impersonationLabel;

  it("shows the engine's value, writes only its own key over /account/screening, and draws what came back", async () => {
    for (const door of ["local", "cloud"] as const) {
      impersonationOn = true;
      asked = [];
      await mountPane([ORGANIZER], door);
      expect(switchNamed(IMPERSONATION)!.getAttribute("aria-checked")).toBe("true");
      expect(hostEl.textContent).toContain(en.desktopScreener.impersonationWhy);
      await act(async () => { switchNamed(IMPERSONATION)!.click(); });
      await settle();
      const write = asked.find((a) => a.method === "PATCH" && a.url === "/account/screening");
      expect(write?.body, door).toBe(JSON.stringify({ impersonationFiling: false }));
      expect(switchNamed(IMPERSONATION)!.getAttribute("aria-checked")).toBe("false");
      await closePane();
    }
  });

  it("an engine from before the switch draws none", async () => {
    await mountPane([ORGANIZER]);
    expect(switchNamed(IMPERSONATION)).toBeNull();
  });
});

describe("the hosted door: the shared shell's row over the bridge", () => {
  it("reads the act off the account's consent and writes it through the engine's forward", async () => {
    await mountPane([ORGANIZER], "cloud");
    await waitFor(() => expect(switchNamed(ACT)?.disabled).toBe(false));
    expect(switchNamed(ACT), "the hosted door drew no act switch").not.toBeNull();
    await act(async () => { switchNamed(ACT)!.click(); });
    await settle();
    expect(asked.filter((a) => a.method === "PATCH").map((a) => a.body)).toEqual([JSON.stringify({ autoAct: true })]);
    expect(switchNamed(ACT)!.getAttribute("aria-checked")).toBe("true");
  });

  it("turning automatic suggestions off withdraws the act in the shell's own state", async () => {
    actAt = AT;
    await mountPane([ORGANIZER], "cloud");
    await waitFor(() => expect(switchNamed(ACT)?.getAttribute("aria-checked")).toBe("true"));
    await act(async () => { switchNamed(en.screener.suggest.autoTitle)!.click(); });
    await settle();
    expect(switchNamed(ACT)!.getAttribute("aria-checked"), "the shell kept the act on after suggestions went off").toBe("false");
    expect(switchNamed(ACT)!.disabled).toBe(true);
  });
});

describe("an open pane follows a change made on another device", () => {
  const POSTURE = en.desktopScreener.postureLabel;
  const AI = en.settings.aiLabel;
  const checked = (label: string): string | null | undefined => switchNamed(label)?.getAttribute("aria-checked");

  async function verifyRefresh(refresh: () => void) {
    peopleOnly = false; aiOn = true;
    await mountPane([ORGANIZER], "cloud");
    expect(checked(POSTURE)).toBe("false");
    peopleOnly = true;
    await act(async () => { refresh(); });
    await settle();
    expect(checked(POSTURE), "the open Screener pane kept the old posture").toBe("true");
    await closePane();

    await mountPane([ORGANIZER], "cloud", "ai");
    expect(checked(AI)).toBe("true");
    aiOn = false;
    await act(async () => { refresh(); });
    await settle();
    expect(checked(AI), "the open AI pane kept the old switch").toBe("false");
  }

  it("the Screener and AI switches take the account's new values when the window comes back", async () => {
    await verifyRefresh(() => { window.dispatchEvent(new Event("focus")); });
    aiOn = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(checked(AI)).toBe("true");
    for (const failure of ["offline", "malformed"] as const) {
      aiRead = failure;
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(checked(AI)).toBe("false");
      expect(switchNamed(AI)?.disabled).toBe(true);
      expect(hostEl.textContent).toContain(en.settings.aiUnreadable);
      await act(async () => { switchNamed(AI)?.click(); });
      expect(asked.some(({ method, url }) => method === "PATCH" && url === "/account/ai")).toBe(false);

      aiRead = "valid";
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(checked(AI)).toBe("true");
      expect(switchNamed(AI)?.disabled).toBe(false);
      expect(hostEl.textContent).not.toContain(en.settings.aiUnreadable);
    }

    const connection = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    try {
      for (const status of [503, 200]) {
        let settleWrite!: (status: number) => void;
        pendingAiWrite = new Promise((resolve) => { settleWrite = resolve; });
        const beforeWrite = asked.length;
        await act(async () => { switchNamed(AI)!.click(); });
        expect(asked.slice(beforeWrite).some(({ method, url }) => method === "PATCH" && url === "/account/ai")).toBe(true);

        connection.mockReturnValue(false);
        await act(async () => { window.dispatchEvent(new Event("offline")); });
        expect(switchNamed(AI)?.disabled, "going offline during the write must clear the switch").toBe(true);

        if (status === 200) {
          // A reconnect during the write is reconciled only after the account could have stored it.
          connection.mockReturnValue(true);
          const beforeReconnect = asked.filter(({ method, url }) => method === "GET" && url === "/account/ai").length;
          await act(async () => { window.dispatchEvent(new Event("online")); });
          expect(asked.filter(({ method, url }) => method === "GET" && url === "/account/ai")).toHaveLength(beforeReconnect);
          expect(switchNamed(AI)?.disabled).toBe(true);
        }
        await act(async () => { settleWrite(status); });
        if (status === 503) {
          expect(switchNamed(AI)?.disabled, "a late refusal must not restore On while offline").toBe(true);
          expect(checked(AI)).toBe("false");
          connection.mockReturnValue(true);
          await act(async () => { window.dispatchEvent(new Event("online")); });
        }
        await waitFor(() => expect(checked(AI)).toBe("true"));
        expect(switchNamed(AI)?.disabled).toBe(false);
      }
    } finally {
      pendingAiWrite = undefined;
      connection.mockRestore();
    }
  });

  it("…and while the window stays in front, within 30 s", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await verifyRefresh(() => { vi.advanceTimersByTime(30_000); });
    } finally {
      vi.useRealTimers();
    }
  });
});
