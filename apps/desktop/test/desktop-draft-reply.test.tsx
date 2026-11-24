/** @vitest-environment jsdom */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { draftReplyOverBridge, draftReplyOverBridgeFor } from "../src/local-draft-reply.js";
import { act, message, mountShell, press, stubDom, unmountAll, waitFor } from "../../webapp/test/_draft-shell.js";
import write from "../../../packages/app/messages/write.en.json";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface DesktopHost {
  __TAURI_INTERNALS__?: { invoke: Invoke };
}
const desktop = globalThis as unknown as DesktopHost;
interface EngineRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
}
let engineRequests: EngineRequest[];
/** What the engine answers the draft POST with; null is the 202. */
let draftRefusal: { status: number; body: string } | null;
const standalone = draftReplyOverBridgeFor({ mode: "local" } as EngineStatus);

function frame(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const bytes = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(bytes.buffer).setUint32(0, meta.byteLength, false);
  bytes.set(meta, 4);
  bytes.set(payload, 4 + meta.byteLength);
  return bytes;
}

beforeEach(() => {
  engineRequests = [];
  draftRefusal = null;
  stubDom();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("draft-key-1111-1111-1111-111111111111");
  desktop.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command !== "engine_request") throw new Error(`unexpected desktop command: ${command}`);
      const request = payload as { method: string; url: string; headers: Array<[string, string]> };
      engineRequests.push(request);
      if (request.method === "POST" && request.url === "/messages/m1/draft") {
        if (draftRefusal) return frame(draftRefusal.status, draftRefusal.body);
        return frame(202, JSON.stringify({ draftId: "d1" }));
      }
      if (request.method === "GET" && request.url === "/drafts/d1") {
        return frame(200, JSON.stringify({ body: "Thursday works.", html: "<p>Thursday works.</p>" }));
      }
      throw new Error(`unexpected engine request: ${request.method} ${request.url}`);
    },
  };
});

afterEach(async () => {
  await unmountAll();
  delete desktop.__TAURI_INTERNALS__;
});

// Drive the desktop reply from its Ohbox row with the keyboard. Draft reply makes one request from the reply footer, which also reports its status.
const OPEN = '[role="region"][aria-label="Open message"]';
/** Write's reply text in the open letter (before, today's `.read-col .msg .rte-surface`). */
const replySurface = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>(`${OPEN} [role="textbox"][aria-label="Reply body"]`);
/** The drafter's one control at the reply's foot. */
const draftControl = (el: HTMLElement): HTMLButtonElement | null =>
  [...el.querySelectorAll<HTMLButtonElement>(`${OPEN} button`)]
    .find((b) => (b.textContent ?? "").includes(write.write.draft.verb) || b.getAttribute("aria-label") === write.write.draft.verb) ?? null;
/** Write's reply in the open letter: the sheet named "Reply to <name>" that holds the reply's text. */
const replySheet = (el: HTMLElement): HTMLElement | null =>
  [...el.querySelectorAll<HTMLElement>(`${OPEN} [aria-label^="Reply to "]`)]
    .find((s) => s.querySelector('[role="textbox"][aria-label="Reply body"]') !== null) ?? null;
/**
 * The drafter's sentence: the line the reply says over its foot (a status; a reply with no files, no forward and no
 * refusal of its send says no other), or null where it says none.
 */
const draftNote = (el: HTMLElement): string | null => {
  const said = [...(replySheet(el)?.querySelectorAll<HTMLElement>('[role="status"]') ?? [])]
    .map((n) => (n.textContent ?? "").trim()).filter((t) => t !== "");
  if (said.length > 1) throw new Error(`the reply says more than one line: ${JSON.stringify(said)}`);
  return said[0] ?? null;
};

/** Open the letter m1 at the Ohbox and its reply, where a person writes one. */
async function openReply(shell: Awaited<ReturnType<typeof mountShell>>) {
  await waitFor(() => shell.el.querySelector("section[aria-label=\"Messages\"] [role=option][data-id='m1']") !== null, "the message row");
  await press(shell.el.querySelector("section[aria-label=\"Messages\"] [role=option][data-id='m1']"), "the message row");
  await waitFor(() => shell.el.querySelector(`${OPEN} h2`) !== null, "the open letter");
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
  });
  await waitFor(() => replySurface(shell.el) !== null, "the reply");
}

/** Open the reply and request its draft. */
async function pressDraftReply(shell: Awaited<ReturnType<typeof mountShell>>) {
  await openReply(shell);
  await waitFor(() => draftControl(shell.el) !== null, "the Draft reply control");
  await press(draftControl(shell.el), "Draft reply");
}

describe("Desktop AI reply drafts", () => {

  it("picks the no-model sentence by who can choose the model", () => {
    expect(standalone.noModel).toBe("noModelHere");
    expect(draftReplyOverBridgeFor({ mode: "cloud", flavor: "desktop-host" } as EngineStatus).noModel)
      .toBe("noModelHost");
    expect(draftReplyOverBridgeFor({ mode: "cloud" } as EngineStatus)).toBe(draftReplyOverBridge);
    expect(draftReplyOverBridge.noModel).toBeUndefined();
    for (const key of ["noModelHere", "noModelHost"] as const) {
      expect(en.draftReply[key], key).toContain("Settings → Desktop");
      expect(de.draftReply[key], key).toContain("Einstellungen → Desktop");
    }
  });

  it("reproduces the pre-fix Desktop notice when no draft wire is supplied", async () => {
    // Before this transport was wired, Desktop's refusing Cloud API stub was the only route.
    // In 2.0 (its never-red row): over no draft wire the reply draws no Draft control, so nothing can be pressed and
    // no request leaves; today's refusing notice was the only route there (Write: no wire, no control).
    const shell = await mountShell("#/ohbox", [message("m1")]);
    await openReply(shell);

    expect(draftControl(shell.el), "a Draft reply control stands over no draft wire").toBeNull();
    expect(engineRequests).toEqual([]);
  }, 15_000);

  it("shows the unavailable notice when Desktop has no engine bridge", async () => {
    delete desktop.__TAURI_INTERNALS__;
    const shell = await mountShell("#/ohbox", [message("m1")], [], { draftReplyWire: draftReplyOverBridge });
    await pressDraftReply(shell);
    await waitFor(() => draftNote(shell.el) !== null, "the unavailable notice");

    expect(draftNote(shell.el)).toBe("Drafting needs a connected account.");
    expect(engineRequests).toEqual([]);
  }, 15_000);

  /** Press Draft it on a door's wire with the engine refusing, and read the notice. */
  async function refusedNotice(refusal: { status: number; body: string }, wire = standalone): Promise<string | null> {
    draftRefusal = refusal;
    const shell = await mountShell("#/ohbox", [message("m1")], [], { draftReplyWire: wire });
    await pressDraftReply(shell);
    await waitFor(() => draftNote(shell.el) !== null, "the engine's refusal");
    expect(engineRequests.map(({ method, url }) => [method, url])).toEqual([["POST", "/messages/m1/draft"]]);
    return draftNote(shell.el);
  }
  const envelope = (code: string, message: string, details?: unknown): string =>
    JSON.stringify({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
  const NO_DRAFTER = { status: 503, body: envelope("drafter_unconfigured", "this deployment has no AI drafter connected") };

  it("says where to choose a model when this install has none, from the catalogue", async () => {
    expect(await refusedNotice(NO_DRAFTER)).toBe(write.draftReply.noModelHere);
  }, 15_000);

  it("keeps the engine's sentence for a missing drafter on the account door, as the web does", async () => {
    expect(await refusedNotice(NO_DRAFTER, draftReplyOverBridge)).toBe("this deployment has no AI drafter connected");
  }, 15_000);

  it("says its own failure sentence for a refusal that is no envelope", async () => {
    // An HTML 502 from a relay: no code, and "the mail engine answered 502" is no sentence for a person.
    expect(await refusedNotice({ status: 502, body: "<html><body>Bad Gateway</body></html>" }))
      .toBe(write.draftReply.failed);
  }, 15_000);

  it.each([
    ["returned", write.draftReply.creditsReturned],
    ["owed", write.draftReply.creditsOwed],
  ])("says the credits were %s when a charged draft failed", async (credits, said) => {
    expect(await refusedNotice({
      status: 503, body: envelope("ai_draft_failed", "the draft could not be written", { credits }),
    })).toBe(said);
  }, 15_000);

  it("opens the generated reply for a sign-in message", async () => {
    const source = message("m1", {
      subject: "Your sign-in code",
      sensitivity: { sensitive: true, category: "otp", no_ai: true, no_forward: true, no_kb: true, priority: true },
    });
    const shell = await mountShell("#/ohbox", [source], [], { draftReplyWire: draftReplyOverBridge });
    await pressDraftReply(shell);
    await waitFor(() => replySurface(shell.el)?.textContent?.includes("Thursday works.") === true, "the draft");
    expect(engineRequests.map(({ method, url }) => [method, url])).toEqual([
      ["POST", "/messages/m1/draft"],
      ["GET", "/drafts/d1"],
    ]);
    expect(draftNote(shell.el)).toBeNull();
  }, 15_000);

  it("creates and reads through the engine, keeps the press key, and lands text in the editor", async () => {
    const shell = await mountShell("#/ohbox", [message("m1")], [], { draftReplyWire: draftReplyOverBridge });
    await pressDraftReply(shell);
    await waitFor(
      () => replySurface(shell.el)?.textContent?.includes("Thursday works.") === true,
      "the generated text in the reply editor",
    );

    expect(engineRequests.map(({ method, url }) => [method, url])).toEqual([
      ["POST", "/messages/m1/draft"],
      ["GET", "/drafts/d1"],
    ]);
    expect(engineRequests[0]?.headers.find(([name]) => name.toLowerCase() === "idempotency-key")?.[1])
      .toBe("draft-key-1111-1111-1111-111111111111");
    expect(engineRequests[1]?.headers.some(([name]) => name.toLowerCase() === "idempotency-key")).toBe(false);
    expect(draftNote(shell.el)).toBeNull();
  }, 15_000);
});
