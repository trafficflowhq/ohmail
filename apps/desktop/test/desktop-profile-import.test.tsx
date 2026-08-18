/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import messages from "../../webapp/messages/en.json";
import { ProfileImportCard, useProfileImport } from "../../webapp/app/shell/ProfileImportCard";
import { profileImportDoorFor } from "../src/doors.js";
import { profileImportOverBridge, profileImportPath } from "../src/local-profile-import.js";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * "WE FOUND YOUR OHMAIL SETTINGS ON THIS MAILBOX" — in the APP, on both doors.
 *
 * The card shipped in the browser and asked nothing here: `apiConfigured()` is false in every
 * desktop build (the Cloud client is a refusing stub), so the shared hook's own gate withheld
 * the one tier whose whole story is "connect the mailbox and the settings it travelled with are
 * waiting". The engine on this machine has served the three confirm routes all along
 * (`localRoutes` mounts the mailbox group; the sidecar e2e drives them against a real server) —
 * what was missing was only the WIRE from this window to it.
 *
 * ── WHAT MUST BE TRUE ────────────────────────────────────────────────────────────────────────
 *
 *  1. THE TRANSPORT RIDES THE PIPE, addressed root-relative to the engine: one GET for the
 *     question, the confirmation's POST carrying the exact fingerprint shown, the dismissal's
 *     POST carrying the content it dismisses. On the STANDALONE door the engine answers from the
 *     store on this machine; on the HOSTED door it forwards to the account with the bearer —
 *     the same three paths either way, which is why one transport serves both doors.
 *  2. IT IS THE SHARED CARD, not a copy: the same component, the same hook, the same tolerant
 *     reader. A second implementation would be a second definition of what "answered" means.
 *  3. A REFUSAL CARRIES THE ENGINE'S SENTENCE. The 409 for a changed document says "review them
 *     again" — advice the generic retry line does not give — and the transport's rejection
 *     contract is what carries it to the card verbatim.
 *  4. BOTH DOORS GET IT, differently gated: the standalone door unconditionally (the engine is
 *     this install's own), the hosted door only signed in. `profileImportDoorFor` is the rule,
 *     as a pure function a test drives.
 *  5. NOTHING REACHES THE CLOUD CLIENT. `fetch` is booby-trapped below.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), "utf8");

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke };
}
const host = globalThis as unknown as Host;

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

const MB = { id: "6e0a4c1e-0000-4000-8000-000000000001", address: "sam@example.com" };
const FINGERPRINT = "b".repeat(64);

interface Asked { method: string; url: string; body: Record<string, unknown> | null }
let asked: Asked[];

/** What the engine currently answers the candidate question with. */
let candidate: Record<string, unknown>;
/** When set, the confirmation's POST answers this refusal instead of applying. */
let applyRefusal: { status: number; code: string; message: string } | null;

function engineAnswering(): void {
  host.__TAURI_INTERNALS__ = {
    invoke: async (_command, payload) => {
      const p = (payload ?? {}) as { method?: string; url?: string; body?: number[] };
      const raw = p.body && p.body.length > 0 ? new TextDecoder().decode(Uint8Array.from(p.body)) : "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const method = (p.method ?? "GET").toUpperCase();
      const url = p.url ?? "";
      asked.push({ method, url, body });
      if (url === profileImportPath(MB.id) && method === "GET") {
        return encode(200, JSON.stringify(candidate));
      }
      if (url === profileImportPath(MB.id) && method === "POST") {
        if (applyRefusal) {
          return encode(applyRefusal.status, JSON.stringify({
            error: { code: applyRefusal.code, message: applyRefusal.message },
          }));
        }
        return encode(200, JSON.stringify({
          imported: { screener: 1, rules: 2, notifyRules: 0, tags: 1, awayResponder: false },
          skippedRules: 0,
          seq: 7,
        }));
      }
      if (url === `${profileImportPath(MB.id)}/decline` && method === "POST") {
        return encode(200, JSON.stringify({ dismissed: true }));
      }
      return encode(404, JSON.stringify({ error: { code: "not_found", message: "no such route" } }));
    },
  };
}

let hostEl: HTMLDivElement;
let root: Root;

/** The REAL hook + the REAL card, over the REAL bridge transport — `AppShell`'s exact wiring. */
async function mountCard(): Promise<void> {
  function Probe(): React.ReactElement | null {
    const state = useProfileImport(true, [MB], profileImportOverBridge);
    if (!state.offer) return h("div", { className: "no-card" });
    return h(ProfileImportCard as never, {
      offer: state.offer,
      phase: state.phase,
      onImport: state.importNow,
      onNotNow: state.notNow,
      onAcknowledge: state.acknowledge,
    } as never);
  }
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-18T12:00:00.000Z"),
        children: h(Probe),
      }),
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const card = (): HTMLElement | null => hostEl.querySelector(".pfi-card");

const button = (label: string): HTMLButtonElement => {
  const el = Array.from(hostEl.querySelectorAll("button"))
    .find((b) => (b.textContent ?? "").trim() === label);
  if (!el) throw new Error(`no button labelled "${label}"`);
  return el;
};

const click = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

beforeEach(() => {
  asked = [];
  applyRefusal = null;
  candidate = {
    state: "found",
    fingerprint: FINGERPRINT,
    updatedAt: "2026-08-10T09:00:00.000Z",
    producer: { kind: "cloud", version: "1" },
    counts: { screener: 1, rules: 2, notifyRules: 0, tags: 1, awayResponder: false },
  };
  engineAnswering();
  /* BOOBY TRAP. Nothing on this path may reach the hosted client: this window has
     `connect-src 'none'` and the packaged bundle has no API client at all. A fallback to it
     would land here rather than passing quietly. */
  globalThis.fetch = (async () => {
    throw new Error("the desktop window opened a socket — nothing here may reach the network");
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  hostEl?.remove();
  delete host.__TAURI_INTERNALS__;
});

describe("the restore card over the bridge", () => {
  /**
   * THE ROUTES, AS LITERALS — the away suite's rule: everything below addresses
   * `profileImportPath`, so these assertions would stay green around a wrong constant. They are
   * the engine's own mounted paths (`packages/api/src/routes/mailboxes.ts`), the same three the
   * hosted client calls, which is what lets ONE transport serve both doors.
   */
  it("addresses the engine's own three routes, spelled exactly", () => {
    expect(profileImportPath(MB.id)).toBe(`/mailboxes/${MB.id}/profile-import`);
    // The id travels URL-encoded — an id is server-minted today, but the path is built from it.
    expect(profileImportPath("a/b")).toBe("/mailboxes/a%2Fb/profile-import");
  });

  it("asks over the pipe and renders the offer from the engine's answer", async () => {
    await mountCard();
    expect(asked).toEqual([{ method: "GET", url: profileImportPath(MB.id), body: null }]);
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain("We found your ohmail settings");
    expect(card()!.textContent).toContain("sam@example.com");
  });

  it("Import sends the exact fingerprint shown, and the confirmation renders the engine's answer", async () => {
    await mountCard();
    await click(button("Import settings"));
    const posts = asked.filter((a) => a.method === "POST");
    expect(posts).toEqual([
      { method: "POST", url: profileImportPath(MB.id), body: { fingerprint: FINGERPRINT } },
    ]);
    expect(card()!.textContent).toContain("Your settings are back");
  });

  it("Not now records the durable dismissal, keyed to the content it dismisses", async () => {
    await mountCard();
    await click(button("Not now"));
    const posts = asked.filter((a) => a.method === "POST");
    expect(posts).toEqual([
      { method: "POST", url: `${profileImportPath(MB.id)}/decline`, body: { fingerprint: FINGERPRINT } },
    ]);
    expect(card()).toBeNull();
  });

  it("a refused apply puts the ENGINE's sentence on the card — the transport's rejection contract", async () => {
    // The 409 for a changed document. Its sentence is an instruction ("review them again")
    // that the generic retry line does not give; the transport promises its rejections carry
    // the engine's own words, and the shared hook shows an injected transport's message.
    applyRefusal = {
      status: 409, code: "profile_changed",
      message: "The saved settings changed since you looked. Review them again before importing.",
    };
    await mountCard();
    await click(button("Import settings"));
    expect(card()!.textContent).toContain("Review them again before importing.");
    // The decision survives the refusal: the offer and both buttons are still there.
    expect(button("Import settings")).toBeDefined();
    expect(button("Not now")).toBeDefined();
  });
});

/** WHICH DOOR MAY ASK — the decision on its own, without a window around it. */
describe("the door that may ask about found settings", () => {
  const serving = (over: Partial<EngineStatus>): EngineStatus => ({
    state: "serving", mailboxId: "mbx-1", credentialState: "ready", ...over,
  });

  it("the STANDALONE door always may — the engine it asks is this install's own", () => {
    expect(profileImportDoorFor(serving({ mode: "local" }))).toBe("local");
    // Even without the mailbox password: the resting answer is a marker read, no dial, and a
    // held question the engine cannot re-verify is a 502 the hook already swallows.
    expect(profileImportDoorFor(serving({ mode: "local", credentialState: "absent" }))).toBe("local");
  });

  it("the HOSTED door may when signed in — the engine forwards to the account with the bearer", () => {
    expect(profileImportDoorFor(serving({ mode: "cloud" }))).toBe("cloud");
  });

  it("nothing while there is no hosted session, no door, or no answer from the shell", () => {
    expect(profileImportDoorFor(serving({ mode: "cloud", credentialState: "absent" }))).toBeNull();
    expect(profileImportDoorFor(serving({ mode: "cloud", credentialState: "unreadable" }))).toBeNull();
    expect(profileImportDoorFor(serving({ mode: "cloud", credentialState: "unknown" }))).toBeNull();
    expect(profileImportDoorFor(serving({ mode: null }))).toBeNull();
    expect(profileImportDoorFor(null)).toBeNull();
  });
});

/**
 * THE WIRING BETWEEN TWO APPLICATIONS, PINNED BY SOURCE — the away suite's argument verbatim:
 * the behaviour is driven above and in the shared client's own suite, but the edge between
 * `DesktopGate` and the shared shell has no single place to render, and deleting it leaves
 * every suite in both applications green.
 */
describe("the wiring, pinned by source", () => {
  const gate = read("src/DesktopGate.tsx");
  const shell = fs.readFileSync(
    path.resolve(APP, "../webapp/app/shell/AppShell.tsx"),
    "utf8",
  );

  it("the window hands its transport in by the door rule", () => {
    expect(gate).toMatch(
      /\{\.\.\.\(profileImportDoorFor\(status\) !== null \? \{ profileImportTransport: profileImportOverBridge \} : \{\}\)\}/,
    );
  });

  it("the shared shell threads the host wire into the one import state", () => {
    expect(shell).toMatch(/const profileImportOffer = useProfileImport\(!demo, facts, profileImportTransport\);/);
  });

  it("the shared files name none of the transport — no bridge, no Tauri, no engine", () => {
    const cardSource = fs.readFileSync(
      path.resolve(APP, "../webapp/app/shell/ProfileImportCard.tsx"),
      "utf8",
    );
    for (const shared of [shell, cardSource]) {
      expect(shared).not.toMatch(/bridgeFetch|__TAURI/);
    }
    // …and the card is genuinely the shared one, imported rather than reimplemented here.
    expect(fs.existsSync(path.join(APP, "src", "DesktopProfileImport.tsx"))).toBe(false);
    expect(read("src/local-profile-import.ts")).toMatch(/from "\.\/bridge-fetch\.js"/);
  });
});
