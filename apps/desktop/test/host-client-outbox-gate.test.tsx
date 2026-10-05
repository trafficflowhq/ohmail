/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { OhmailEngine } from "@ohmail/client-engine";

import messages from "../../webapp/messages/en.json";
import { BearerManager } from "../src/host-client/bearer.js";
import { HostGate } from "../src/host-client/HostGate.js";

/**
 * WHAT THE PAIRED PAGE KEEPS GOES WITH THE PAIRING, AND A BROWSER THAT KEEPS NOTHING SAYS SO.
 * The gate is rendered with the shell captured: its engine is driven, the discard it asks for is
 * recorded, and the strip it hands the shell is rendered. What a discard and the store do to a
 * real IndexedDB is measured with `fake-indexeddb`, beside the engine's own tests.
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

let shellProps: Record<string, unknown> | null = null;
let pairProps: { onPaired: () => void } | null = null;
/** Every discard the gate asked for, in order: `undefined` is every pairing's. */
let discards: Array<{ except?: string | null } | undefined> = [];

vi.mock("../../webapp/app/shell/AppShell", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/shell/AppShell")>(
    "../../webapp/app/shell/AppShell",
  );
  return { ...real, AppShell: (props: Record<string, unknown>) => { shellProps = props; return null; } };
});
vi.mock("../src/host-client/PairScreen.js", async () => {
  const real = await vi.importActual<typeof import("../src/host-client/PairScreen.js")>(
    "../src/host-client/PairScreen.js",
  );
  return { ...real, PairScreen: (props: { onPaired: () => void }) => { pairProps = props; return null; } };
});
vi.mock("../src/host-client/outbox-store.js", async () => {
  const real = await vi.importActual<typeof import("../src/host-client/outbox-store.js")>(
    "../src/host-client/outbox-store.js",
  );
  return {
    ...real,
    discardHostOutbox: (opts?: { except?: string | null }) => { discards.push(opts); return real.discardHostOutbox(opts); },
  };
});

type Mode = "away" | "revoked";
let mode: Mode;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function pairedBearer(): BearerManager {
  const bearer = new BearerManager({
    storage: window.localStorage,
    fetchImpl: (async (url: string) => {
      if (mode === "away") throw new TypeError("Failed to fetch");
      // Ended from the computer: every request and the rotation are refused by name.
      if (url === "/auth/refresh") return json(401, { error: { code: "refresh_revoked", message: "revoked" } });
      return json(401, { error: { code: "unauthorized", message: "revoked" } });
    }) as never,
  });
  bearer.adopt({ accessToken: "a1", refreshToken: "r1" }, { fresh: true });
  return bearer;
}

/**
 * A DATABASE THAT OPENS AND ANSWERS — the store's success path and nothing more, for the control.
 * `fake-indexeddb` is another package's; its semantics are measured there.
 */
function answeringDatabase(): { factory: IDBFactory; rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  const later = (fn: () => void): void => { setTimeout(fn, 0); };
  type Req = { result?: unknown; onsuccess?: () => void; onerror?: () => void };
  const answer = (value: () => unknown): Req => {
    const req: Req = {};
    later(() => { req.result = value(); req.onsuccess?.(); });
    return req;
  };
  const store = {
    getAllKeys: () => answer(() => [...rows.keys()].map((k) => JSON.parse(k) as unknown)),
    getAll: () => answer(() => [...rows.values()]),
    // A put reads the row it replaces first (another tab's Cancel mark is kept), as a real store answers.
    get: (k: unknown) => answer(() => rows.get(JSON.stringify(k))),
    put: (v: unknown, k: unknown) => { rows.set(JSON.stringify(k), v); },
    delete: (k: unknown) => { rows.delete(JSON.stringify(k)); },
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    close: () => undefined,
    transaction: () => {
      const tx: { objectStore: () => typeof store; oncomplete?: () => void; error: null } = { objectStore: () => store, error: null };
      later(() => later(() => tx.oncomplete?.()));
      return tx;
    },
  };
  return { factory: { open: () => answer(() => db) } as unknown as IDBFactory, rows };
}

const ticks = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

let root: Root | null = null;
let hostEl: HTMLDivElement | null = null;

async function mount(bearer: BearerManager): Promise<void> {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", children: h(HostGate, { bearer }),
    }));
  });
  await ticks(2);
}

/** Render a node the gate handed the shell, and read what a person would see. */
async function textOf(node: unknown): Promise<string> {
  const el = document.createElement("div");
  const r = createRoot(el);
  await act(async () => {
    r.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: node as React.ReactNode }));
  });
  const text = el.textContent ?? "";
  await act(async () => r.unmount());
  return text;
}

beforeEach(() => {
  mode = "away";
  shellProps = null;
  pairProps = null;
  discards = [];
  window.localStorage.clear();
  // jsdom has no IndexedDB: the store falls back, which is what the refusal case reads.
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  hostEl?.remove();
  hostEl = null;
  window.history.replaceState(null, "", "/");
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

/** Queue one change on the engine the gate built. */
async function queueOne(): Promise<void> {
  const engine = shellProps!.engine as OhmailEngine;
  await act(async () => { await engine.hydrate(); });
  let status = "";
  await act(async () => { status = (await engine.mutate({ kind: "message_delete", messageId: "m-1" })).status; });
  expect(status).toBe("queued");
  expect(discards).toEqual([]);
}

describe("the queued changes go with the pairing", () => {
  it("signing this device out discards them", async () => {
    const bearer = pairedBearer();
    await mount(bearer);
    await queueOne();
    await act(async () => { await bearer.logout(); });
    await ticks();
    expect(discards).toEqual([undefined]);
  });

  it("a pairing ended from the computer discards them", async () => {
    const bearer = pairedBearer();
    await mount(bearer);
    await queueOne();
    mode = "revoked";
    await act(async () => { await (shellProps!.engine as OhmailEngine).syncOnce().catch(() => undefined); });
    await ticks();
    expect(bearer.paired()).toBe(false);
    expect(discards).toEqual([undefined]);
  });

  it("a fresh pairing discards the earlier pairing's and keeps its own", async () => {
    const bearer = pairedBearer();
    const earlier = bearer.pairScope()!;
    window.history.replaceState(null, "", "/pair");
    await mount(bearer);
    expect(pairProps).not.toBeNull();
    bearer.adopt({ accessToken: "a2", refreshToken: "r2" }, { fresh: true });
    const fresh = bearer.pairScope()!;
    expect(fresh).not.toBe(earlier);
    await act(async () => { pairProps!.onPaired(); });
    await ticks();
    expect(discards).toEqual([{ except: fresh }]);
  });
});

describe("a browser that will not keep them says so, once", () => {
  it("a database that will not open puts the sentence above the app, and it can be put away", async () => {
    await mount(pairedBearer());
    expect(shellProps!.accountNotice).toBeUndefined();
    const engine = shellProps!.engine as OhmailEngine;
    await act(async () => { await engine.hydrate(); });
    await ticks(2);
    const notice = shellProps!.accountNotice;
    expect(notice).toBeDefined();
    expect(await textOf(notice)).toContain(messages.pairLanding.outboxNotKept);

    // Dismissed, it stays away for this pairing.
    const el = document.createElement("div");
    document.body.append(el);
    const r = createRoot(el);
    await act(async () => {
      r.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: notice as React.ReactNode }));
    });
    await act(async () => { el.querySelector("button")!.click(); });
    await act(async () => r.unmount());
    el.remove();
    await ticks(2);
    expect(shellProps!.accountNotice).toBeUndefined();
  });

  it("control: a browser that keeps them says nothing", async () => {
    const answering = answeringDatabase();
    (globalThis as { indexedDB?: unknown }).indexedDB = answering.factory;
    await mount(pairedBearer());
    const engine = shellProps!.engine as OhmailEngine;
    await act(async () => { await engine.hydrate(); });
    await act(async () => { await engine.mutate({ kind: "message_delete", messageId: "m-2" }); });
    await ticks(4);
    expect(answering.rows.size).toBe(1);
    expect(shellProps!.accountNotice).toBeUndefined();
  });
});
