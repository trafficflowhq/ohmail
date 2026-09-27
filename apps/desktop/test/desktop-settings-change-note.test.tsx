/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";

/**
 * THE AWAY ROW, THE DORMANCY DIAL AND THE SIGNATURE EDITORS SAY A READER'S REFUSED CHANGE on the
 * desktop, over the wires both doors take: `awayOverBridge` (both), `consentOverBridge` (hosted)
 * and `consentOverBridgeStandalone`. A scripted engine answers as a reader's server does, and the
 * shared components render from what those wires carried.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

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

const REFUSED = { state: "refused", holder: "work-laptop", refusal: "unreadable" };
const REFUSED_TEXT = en.settings.screening.refusedUnreadable.replace("{name}", "work-laptop");

beforeEach(() => {
  shellHost.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command !== "engine_request") return null;
      const url = String(payload?.url ?? "");
      if (url === "/away-responder") {
        return encode(200, JSON.stringify({
          enabled: false, body: "Back Monday.", startsAt: null, endsAt: null, audience: "screened_in",
          throttle: "per_day", piles: ["INBOX"], updatedAt: "2026-09-26T08:00:00.000Z", change: REFUSED,
        }));
      }
      if (url === "/consent") {
        return encode(200, JSON.stringify({
          seedConfirmedAt: "2026-09-01T08:00:00.000Z", screeningResetAt: null, dormancyDays: 90,
          signatures: {}, signaturesHtml: {}, signatureSources: {},
          dormancyChange: REFUSED, signatureChanges: { "mbx-1": REFUSED },
        }));
      }
      return encode(404, "{}");
    },
  };
});

let hostEl: HTMLDivElement;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  hostEl?.remove();
  delete shellHost.__TAURI_INTERNALS__;
});
const settle = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
};
async function mount(node: React.ReactElement): Promise<void> {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages: en as never, timeZone: "UTC", children: node }));
  });
  await settle();
}

describe("the desktop's away row", () => {
  it("says the refusal the engine's read carries", async () => {
    const { AwayResponderRow } = await import("../../webapp/app/shell/AwayResponderRow");
    const { awayOverBridge } = await import("../src/local-away.js");
    await mount(h(AwayResponderRow as React.FunctionComponent<{ transport: unknown }>, { transport: awayOverBridge }));
    expect(hostEl.textContent, "the refusal reached no surface").toContain(REFUSED_TEXT);
  });
});

describe.each(["hosted", "standalone"] as const)("the %s door's dial and signature editors", (door) => {
  it("say the refusals the consent read carries", async () => {
    const { useConsentState } = await import("../../webapp/app/shell/consent-state");
    const { DormancyRow } = await import("../../webapp/app/shell/DormancyRow");
    const { SignaturesRow } = await import("../../webapp/app/shell/SignaturesRow");
    const wires = await import("../src/local-consent.js");
    const wire = door === "hosted" ? wires.consentOverBridge : wires.consentOverBridgeStandalone;
    /* `AppShell`'s own composition of the two rows, and nothing else of it. */
    function Harness() {
      const c = useConsentState(true, wire);
      if (!c.known) return null;
      return h("div", null,
        h(DormancyRow, { days: c.dormancyDays, scope: c.screeningScope, change: c.dormancyChange, setDormancyDays: c.setDormancyDays }),
        h("div", { className: "sigs" }, h(SignaturesRow, {
          mailboxes: [{ id: "mbx-1", address: "one@example.test", organizerRole: "reader" }],
          signatures: c.signatures, signaturesHtml: c.signaturesHtml, signatureSources: c.signatureSources,
          changes: c.signatureChanges, setMailboxSignature: c.setMailboxSignature,
        })));
    }
    await mount(h(Harness));
    const sigs = hostEl.querySelector(".sigs")!;
    expect(sigs.textContent, "the signature's refusal reached no surface").toContain(REFUSED_TEXT);
    expect(hostEl.textContent!.split(REFUSED_TEXT).length - 1, "the dial's refusal reached no surface").toBe(2);
  });
});
