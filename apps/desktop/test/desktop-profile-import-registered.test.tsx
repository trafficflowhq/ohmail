/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { DesktopGate, LIFECYCLE_POLL_MS } from "../src/DesktopGate.js";
import { DesktopLocale } from "../src/DesktopLocale.js";
import { DOOR_COPY } from "../src/door-copy.js";
import { profileImportPath } from "../src/local-profile-import.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MB = { id: "6e0a4c1e-0000-4000-8000-000000000001", address: "mailbox@example.invalid" };
const FINGERPRINT = "b".repeat(64);
const STANDALONE: EngineStatus = {
  state: "serving", mode: "local", address: MB.address, mailboxId: MB.id, credentialState: "ready",
};
const words = {
  title: "We found your ohmail settings on this mailbox",
  signatureReplacingPart: "your signature, replacing the one on this mailbox now",
  import: "Import settings",
  doneTitle: "Your settings are back.",
  doneAction: "Done",
  later: "Not now",
};
const FOUND = {
  state: "found", fingerprint: FINGERPRINT, updatedAt: "2026-08-10T09:00:00.000Z",
  producer: { kind: "cloud", version: "1" },
  counts: { screener: 1, rules: 2, notifyRules: 0, tags: 1, awayResponder: false },
};
const RECEIPT = { imported: FOUND.counts, skippedRules: 0, seq: 7 };
const CONNECTED = "2026-08-10T09:00:00.000Z";
const EMPTY_CHANGES = { creates: [], updates: [], moves: [], deletes: [] };

interface RegisteredDoor {
  status?: EngineStatus;
  candidate?: () => Promise<Record<string, unknown>>;
  defaultMail?: "not-default";
}
interface RequestBody {
  method?: string;
  url?: string;
  body?: number[];
}
const host = globalThis as unknown as {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, request?: RequestBody) => Promise<unknown>;
    transformCallback: () => number;
  };
};
let root: Root | null;
let hostEl: HTMLDivElement;
let candidate: Record<string, unknown>;
let asked: Array<{ method: string; url: string; body: unknown }>;

/** One encoded reply from the synthetic native engine, in the desktop bridge's actual format. */
function encode(status: number, data: unknown): Uint8Array {
  const encoder = new TextEncoder();
  const meta = encoder.encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = encoder.encode(JSON.stringify(data));
  const result = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(result.buffer).setUint32(0, meta.byteLength, false);
  result.set(meta, 4);
  result.set(payload, 4 + meta.byteLength);
  return result;
}

async function answer(door: RegisteredDoor, method: string, url: string): Promise<Uint8Array> {
  const profile = profileImportPath(MB.id);
  if (method === "GET" && url === profile) return encode(200, await (door.candidate?.() ?? candidate));
  if (method === "POST" && url === profile) return encode(200, RECEIPT);
  if (method === "POST" && url === `${profile}/decline`) return encode(200, { dismissed: true });
  if (url === "/health") return encode(200, { signedIn: true });
  if (/^\/mailboxes(?:\?|$)/.test(url)) {
    return encode(200, { items: [{
      ...MB, status: "connected", lastSyncAt: CONNECTED, initialImportCompletedAt: CONNECTED,
      organizeConsentedAt: CONNECTED,
    }] });
  }
  if (url.startsWith("/sync/snapshot")) {
    return encode(200, { asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } });
  }
  if (url.startsWith("/sync")) {
    return encode(200, { changes: EMPTY_CHANGES, cursor: "MA", hasMore: false, serverTime: CONNECTED });
  }
  if (url.startsWith("/consent")) return encode(200, { seedConfirmedAt: CONNECTED });
  return encode(404, { error: { code: "not_found" } });
}

async function mountRegisteredWindow(door: RegisteredDoor = {}): Promise<void> {
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, request) => {
      if (command === "engine_status") return door.status ?? STANDALONE;
      if (command === "default_mail_status") return { state: door.defaultMail ?? "unknown" };
      if (command !== "engine_request") return null;
      const method = (request?.method ?? "GET").toUpperCase();
      const url = request?.url ?? "";
      const raw = request?.body?.length ? new TextDecoder().decode(Uint8Array.from(request.body)) : "";
      asked.push({ method, url, body: raw ? JSON.parse(raw) : null });
      return answer(door, method, url);
    },
  };
  window.location.hash = "#/ohbox";
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => root!.render(<DesktopLocale><DesktopGate /></DesktopLocale>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
}

const profileTraffic = (verb: "GET" | "POST") =>
  asked.filter(({ method, url }) => method === verb && url.startsWith(profileImportPath(MB.id)));
const card = () => hostEl.querySelector<HTMLElement>(".ob-list .pfi-card");
const button = (label: string): HTMLButtonElement => {
  const found = [...(card()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);
  if (!found) throw new Error(`The offer has no ${label} control`);
  return found;
};
const click = (element: HTMLElement) => act(async () => element.click());

beforeEach(() => {
  root = null;
  asked = [];
  candidate = FOUND;
  localStorage.clear();
  vi.stubGlobal("fetch", async () => { throw new Error("The desktop profile opened a network socket"); });
  window.matchMedia ??= ((media: string) => ({
    matches: false, media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  hostEl?.remove();
  delete host.__TAURI_INTERNALS__;
  window.location.hash = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("offers the connected mailbox's verified settings in the actual desktop mail frame", async () => {
  await mountRegisteredWindow();
  expect(hostEl.querySelector(".fr-frame"), "the native gate should open the actual registered app").not.toBeNull();
  expect(asked.some(({ method, url }) => method === "GET" && /^\/mailboxes(?:\?|$)/.test(url)), "the frame should read its mailbox roster").toBe(true);
  expect(profileTraffic("GET")).toEqual([{ method: "GET", url: profileImportPath(MB.id), body: null }]);
  expect(hostEl.querySelector(".ob-list .pfi-card")?.textContent).toContain(words.title);
  expect(profileTraffic("POST")).toEqual([]);
});

it("the desktop applies the reviewed copy only after the press and shows its receipt", async () => {
  const signatureReplaces = "7".repeat(32);
  candidate = { ...candidate, counts: { ...(candidate.counts as object), signature: true, signatureReplaces } };
  await mountRegisteredWindow();
  expect(card()?.textContent).toContain(words.signatureReplacingPart);
  expect(profileTraffic("POST")).toEqual([]);
  const apply = button(words.import);
  await act(async () => { apply.click(); apply.click(); });
  expect(profileTraffic("POST")).toEqual([
    { method: "POST", url: profileImportPath(MB.id), body: { fingerprint: FINGERPRINT, signatureReplaces } },
  ]);
  expect(card()?.textContent).toContain(words.doneTitle);
  await click(button(words.doneAction));
  expect(card()).toBeNull();
});

it("a prior native account's delayed answer cannot replace the verified current offer", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const previous = Promise.withResolvers<Record<string, unknown>>();
  const oldCandidate = candidate;
  const owner = { ...STANDALONE, localDoorVersion: 1 };
  const replacement = { ...STANDALONE, localDoorVersion: 2 };
  const next = { ...candidate, fingerprint: "d".repeat(64) };
  const door: RegisteredDoor = { status: owner, candidate: () => previous.promise };
  await mountRegisteredWindow(door);
  expect(profileTraffic("GET")).toHaveLength(1);
  expect(card()).toBeNull();
  door.status = replacement;
  door.candidate = async () => next;
  await act(async () => { await vi.advanceTimersByTimeAsync(LIFECYCLE_POLL_MS + 250); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  expect(profileTraffic("GET")).toHaveLength(2);
  expect(card()?.textContent).toContain(words.title);
  await act(async () => previous.resolve(oldCandidate));
  await click(button(words.later));
  expect(profileTraffic("POST")).toEqual([
    { method: "POST", url: `${profileImportPath(MB.id)}/decline`, body: { fingerprint: next.fingerprint } },
  ]);
  expect(card()).toBeNull();
});

it("the native profile offer takes the stage before the default-mail ask", async () => {
  const pending = Promise.withResolvers<Record<string, unknown>>();
  await mountRegisteredWindow({ defaultMail: "not-default", candidate: () => pending.promise });
  expect(hostEl.textContent).toContain(DOOR_COPY.mailtoAskTitle);
  await act(async () => pending.resolve(candidate));
  expect(hostEl.querySelector(".ob-list .pfi-card")?.textContent).toContain(words.title);
  expect(hostEl.textContent).not.toContain(DOOR_COPY.mailtoAskTitle);
  const later = [...card()!.querySelectorAll("button")].find((b) => b.textContent === words.later);
  expect(later).toBeDefined();
  await click(later!);
  expect(card()).toBeNull();
  expect(hostEl.textContent).toContain(DOOR_COPY.mailtoAskTitle);
});

