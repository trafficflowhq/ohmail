/** @vitest-environment jsdom */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { draftReplyOverBridge, draftReplyOverBridgeFor } from "../src/local-draft-reply.js";
import { message, mountShell, press, replySurface, stubDom, unmountAll, waitFor } from "../../webapp/test/_draft-shell.js";

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

async function openDraftReplyOffer(shell: Awaited<ReturnType<typeof mountShell>>) {
  const row = shell.el.querySelector(".row[data-id='m1']");
  await press(row, "the message row");
  await waitFor(() => shell.el.querySelector(".abar-more") !== null, "the message action bar");
  await press(shell.el.querySelector(".abar-more"), "more actions");
  await waitFor(
    () => [...shell.el.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Draft reply"),
    "the Draft reply action",
  );
  const action = [...shell.el.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Draft reply");
  await press(action ?? null, "Draft reply");
  await waitFor(
    () => shell.el.querySelector('[role="group"][aria-label="Draft a reply with AI"]') !== null,
    "the AI draft offer",
  );
}

describe("Desktop AI reply drafts", () => {
  it("hands the shared shell its bridge wire on every Desktop door", () => {
    const repo = existsSync(resolve("apps/desktop/src")) ? resolve(".") : resolve("../..");
    const gate = readFileSync(resolve(repo, "apps/desktop/src/DesktopGate.tsx"), "utf8");
    expect(gate).toContain("draftReplyWire={draftReplyOverBridgeFor(status)}");
  });

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
    const shell = await mountShell("#/ohbox", [message("m1")]);
    await openDraftReplyOffer(shell);

    const confirm = [...shell.el.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Draft it");
    await press(confirm ?? null, "Draft it");
    await waitFor(() => shell.el.querySelector(".dr-note") !== null, "the draft refusal");

    expect(shell.el.querySelector(".dr-note")?.textContent).toBe("Drafting needs a connected account.");
    expect(engineRequests).toEqual([]);
  }, 15_000);

  it("shows the unavailable notice when Desktop has no engine bridge", async () => {
    delete desktop.__TAURI_INTERNALS__;
    const shell = await mountShell("#/ohbox", [message("m1")], [], { draftReplyWire: draftReplyOverBridge });
    await openDraftReplyOffer(shell);

    const confirm = [...shell.el.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Draft it");
    await press(confirm ?? null, "Draft it");
    await waitFor(() => shell.el.querySelector(".dr-note") !== null, "the unavailable notice");

    expect(shell.el.querySelector(".dr-note")?.textContent).toBe("Drafting needs a connected account.");
    expect(engineRequests).toEqual([]);
  }, 15_000);

  /** Press Draft it on a door's wire with the engine refusing, and read the notice. */
  async function refusedNotice(refusal: { status: number; body: string }, wire = standalone): Promise<string | null> {
    draftRefusal = refusal;
    const shell = await mountShell("#/ohbox", [message("m1")], [], { draftReplyWire: wire });
    await openDraftReplyOffer(shell);
    const confirm = [...shell.el.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Draft it");
    await press(confirm ?? null, "Draft it");
    await waitFor(() => shell.el.querySelector(".dr-note") !== null, "the engine's refusal");
    expect(engineRequests.map(({ method, url }) => [method, url])).toEqual([["POST", "/messages/m1/draft"]]);
    return shell.el.querySelector(".dr-note")?.textContent ?? null;
  }
  const envelope = (code: string, message: string, details?: unknown): string =>
    JSON.stringify({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
  const NO_DRAFTER = { status: 503, body: envelope("drafter_unconfigured", "this deployment has no AI drafter connected") };

  it("says where to choose a model when this install has none, from the catalogue", async () => {
    expect(await refusedNotice(NO_DRAFTER)).toBe(en.draftReply.noModelHere);
  }, 15_000);

  it("keeps the engine's sentence for a missing drafter on the account door, as the web does", async () => {
    expect(await refusedNotice(NO_DRAFTER, draftReplyOverBridge)).toBe("this deployment has no AI drafter connected");
  }, 15_000);

  it("says its own failure sentence for a refusal that is no envelope", async () => {
    // An HTML 502 from a relay: no code, and "the mail engine answered 502" is no sentence for a person.
    expect(await refusedNotice({ status: 502, body: "<html><body>Bad Gateway</body></html>" }))
      .toBe(en.draftReply.failed);
  }, 15_000);

  it.each([
    ["returned", en.draftReply.creditsReturned],
    ["owed", en.draftReply.creditsOwed],
  ])("says the credits were %s when a charged draft failed", async (credits, said) => {
    expect(await refusedNotice({
      status: 503, body: envelope("ai_draft_failed", "the draft could not be written", { credits }),
    })).toBe(said);
  }, 15_000);

  it("renders the 422 sensitive refusal as the engine wrote it", async () => {
    expect(await refusedNotice({
      status: 422, body: envelope("sensitive_no_ai", "cannot AI-draft a sensitive message"),
    })).toBe("cannot AI-draft a sensitive message");
  }, 15_000);

  it("creates and reads through the engine, keeps the press key, and lands text in the editor", async () => {
    const shell = await mountShell("#/ohbox", [message("m1")], [], { draftReplyWire: draftReplyOverBridge });
    await openDraftReplyOffer(shell);

    const confirm = [...shell.el.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Draft it");
    await press(confirm ?? null, "Draft it");
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
    expect(shell.el.querySelector(".dr-note")).toBeNull();
  }, 15_000);
});
