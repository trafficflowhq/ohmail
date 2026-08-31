/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import { useConsentState } from "../../webapp/app/shell/consent-state";
import { CONSENT_PATH, CONSENT_SETTINGS_PATH, consentOverBridge } from "../src/local-consent.js";

/**
 * ═══ "APPLY FOR ALL DEVICES" FOR THE FACE, IN THE DESKTOP WINDOW ═════════════════════════════
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────────────────────
 *
 * The appearance face has two scopes (OHMARCHY-PLAN.md §3a): a DEVICE pin, which the theme
 * provider owns and which therefore worked in this window from the day the face shipped, and the
 * ACCOUNT's synced choice, which is one field on the consent row. `AppShell` folds the account
 * write to a NULLABLE callback and withholds the affordance where it is null — so on the hosted
 * door, mirroring a real account whose face lives in that account's row, the "apply for all
 * devices" line was absent while the same account could set it from a browser tab. The transport
 * simply had no `setThemeFace`; nothing else was wrong.
 *
 * ── WHAT MUST BE TRUE ───────────────────────────────────────────────────────────────────────
 *
 *  1. THE REQUEST LEAVES, root-relative, as a forwarded `PATCH /consent/settings`. This window's
 *     content policy is `connect-src 'none'` and the Cloud client is aliased to a refusing stub,
 *     so the requests that go down the bridge are the only evidence there is.
 *  2. ONE AXIS ONLY. The route tests presence with `in`, so a body carrying anything else would
 *     overwrite settings this control does not own — including the dormancy window and the
 *     remote-image opt-out.
 *  3. THE ECHO, NEVER THE ARGUMENT. The scripted account can accept the write and store
 *     something else; the value the shell adopts must be what the account holds.
 *  4. THE HOOK NOW OFFERS THE KNOB on this transport, and still offers NONE on a standalone
 *     window — which is what makes `AppShell`'s gate resolve to a real callback here and to null
 *     there, without `AppShell` knowing anything about doors.
 *  5. NOTHING REACHES THE CLOUD CLIENT — `fetch` is booby-trapped, so a fallback throws rather
 *     than passing quietly.
 *
 * ── MUTATION WATCH (run, then restored) ─────────────────────────────────────────────────────
 *
 *  · delete `setThemeFace` from `consentOverBridge` → cases 1-4's hosted half all go red, which
 *    is exactly the state this slice found;
 *  · have it send `{ themeFace, dormancyDays: 30 }` → the one-axis case goes red;
 *  · have `writeThemeFace` return its argument instead of the answer's `themeFace` → the
 *    disagreement case goes red. `declineWrite` is what makes those two values differ at all:
 *    a server that stores whatever it is told is satisfied identically by a client that echoes
 *    itself, which is how the sibling settings suite once passed against that very mutation.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const host = globalThis as unknown as {
  __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback?: (cb: unknown) => number };
};

/** One answer, framed exactly as the shell frames one for the bridge. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Asked { method: string; url: string; body: Record<string, unknown> | null }
let asked: Asked[];
/** The account's stored face, as the hosted API answers it through the engine's forward. */
let themeFace: "paper" | "ohmarchy" | null;
/** The account ACCEPTS the write and leaves the row as it was — a policy answered 200. */
let declineWrite: boolean;

function engineAnswering(): void {
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      const p = (payload ?? {}) as { method?: string; url?: string; body?: number[] };
      const raw = p.body && p.body.length > 0 ? new TextDecoder().decode(Uint8Array.from(p.body)) : "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      if (command !== "engine_request") return undefined;
      asked.push({ method: p.method ?? "GET", url: p.url ?? "", body });

      if (p.url === CONSENT_PATH) {
        return encode(200, JSON.stringify({
          seedConfirmedAt: "2026-08-13T09:00:00.000Z",
          screeningResetAt: null,
          dormancyDays: 90,
          screeningBaselineAt: null,
          autoSuggestAt: null,
          blockRemoteImagesAt: null,
          blockAutoUnsubscribeAt: null,
          locale: null,
          themeFace,
          counts: { decidedSenders: 4, activeUndecidedSenders: 3, dormantUndecidedSenders: 0 },
        }));
      }
      if (p.url === CONSENT_SETTINGS_PATH) {
        if (body && "themeFace" in body && !declineWrite) {
          themeFace = body.themeFace as "paper" | "ohmarchy" | null;
        }
        return encode(200, JSON.stringify({ themeFace }));
      }
      return encode(404, JSON.stringify({ error: { code: "not_found", message: "no such route" } }));
    },
  };
}

/** The requests that left, as `METHOD path` — the only evidence a window with no socket has. */
const wire = (): string[] => asked.map((a) => `${a.method.toUpperCase()} ${a.url}`);

/**
 * `AppShell`'s own gate over this hook, and nothing else of it: the shell computes
 * `applyFaceAllDevices` as `!demo && themeFaceKnown && consent.setThemeFace !== null`, hands it
 * to the settings row, and the row withholds the line when it is null. Mounting the whole shell
 * would take an engine, a mirror and a router to observe one wire.
 */
function FaceHarness({ transport }: { transport: boolean }) {
  const consent = useConsentState(true, transport ? consentOverBridge : undefined);
  const gate = consent.themeFaceKnown && consent.setThemeFace !== null;
  return h(
    "div",
    null,
    h("span", { className: "probe-known" }, String(consent.known)),
    h("span", { className: "probe-standalone" }, String(consent.standalone)),
    h("span", { className: "probe-face-known" }, String(consent.themeFaceKnown)),
    h("span", { className: "probe-face" }, String(consent.themeFace)),
    h("span", { className: "probe-gate" }, String(gate)),
    gate
      ? h(
          "button",
          { onClick: () => { void consent.setThemeFace!("ohmarchy"); } },
          "Apply for all devices",
        )
      : null,
  );
}

let el: HTMLDivElement;
let root: Root;

const settle = async (): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function mount(node: React.ReactElement): Promise<void> {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root.render(node); });
  await settle();
}

const text = (sel: string): string => el.querySelector(sel)?.textContent?.trim() ?? "";
const press = async (): Promise<void> => {
  const button = el.querySelector("button");
  if (!button) throw new Error(`no apply button — on screen: ${el.textContent}`);
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
};

beforeEach(() => {
  asked = [];
  themeFace = null;
  declineWrite = false;
  engineAnswering();
  /* BOOBY TRAP — nothing on this path may reach the hosted client. This window has
     `connect-src 'none'` and the packaged bundle has no API client at all, so a fallback to it
     lands here rather than passing quietly. */
  globalThis.fetch = (async () => {
    throw new Error("the desktop window opened a socket — nothing here may reach the network");
  }) as typeof fetch;
});

describe("the hosted door can store the account's face", () => {
  it("reads the account's face down the pipe and offers the apply-all knob", async () => {
    await mount(h(FaceHarness, { transport: true }));

    expect(wire(), "GET /consent never left — the shell is not reading the account's row")
      .toContain(`GET ${CONSENT_PATH}`);
    expect(text(".probe-known")).toBe("true");
    expect(text(".probe-standalone")).toBe("false");
    // `themeFaceKnown`, not `known`: the face is only adoptable once the LIVE read carried it.
    expect(text(".probe-face-known")).toBe("true");
    expect(text(".probe-face")).toBe("null"); // the account has no preference yet
    expect(text(".probe-gate"), "the affordance is offered on this door now").toBe("true");
  });

  it("writes the face to the account, ONE axis, and adopts what the account STORED", async () => {
    await mount(h(FaceHarness, { transport: true }));
    await press();

    const write = asked.find((a) => a.url === CONSENT_SETTINGS_PATH);
    expect(write?.method.toUpperCase()).toBe("PATCH");
    expect(write?.body, "one axis — the row's other settings are not this control's to move")
      .toEqual({ themeFace: "ohmarchy" });
    expect(themeFace, "the account row holds it").toBe("ohmarchy");
    expect(text(".probe-face")).toBe("ohmarchy");
  });

  it("…and shows the ACCOUNT's answer even when it disagrees with the press", async () => {
    /* The account accepts the request and leaves the row as it was. Answered 200, so there is no
       error to catch, and the only thing separating "the account adopted ohmarchy" from "it did
       not" is whether the hook reads the echo or the argument it sent. */
    declineWrite = true;
    await mount(h(FaceHarness, { transport: true }));
    await press();

    expect(themeFace, "the account really stored nothing").toBeNull();
    expect(text(".probe-face"), "the shell must not claim a face the account refused").toBe("null");
  });

  it("A STANDALONE WINDOW GETS NONE OF IT, structurally — no transport, no account, no knob", async () => {
    await mount(h(FaceHarness, { transport: false }));

    // Nothing was asked: there is no account row behind a standalone engine to hold a face.
    expect(wire()).toEqual([]);
    expect(text(".probe-known")).toBe("false");
    expect(text(".probe-standalone")).toBe("true");
    expect(text(".probe-gate")).toBe("false");
    expect(el.querySelector("button")).toBeNull();
  });
});
