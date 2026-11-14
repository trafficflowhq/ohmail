/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { OhmailEngine } from "@ohmail/client-engine";
import type { FeatureEntry, HostContract } from "@ohmail/app/host";

import messages from "../../webapp/messages/en.json";
import { COMPOSE_DRAFT_PREFIX } from "@ohmail/app-logic/writing/compose";
import { BearerManager, OWED_SIGN_OUTS_STORAGE_KEY } from "../../paired-page/src/bearer.js";
import { HostGate, PAIRED_PANE_PARTS } from "../../paired-page/src/HostGate.js";

/**
 * WHAT THE PAIRED PAGE KEEPS GOES WITH THE PAIRING, AND A BROWSER THAT KEEPS NOTHING SAYS SO.
 * The gate is rendered with the shell captured: its engine is driven, the discard it asks for is
 * recorded, and the strip it hands the shell is rendered. What a discard and the store do to a
 * real IndexedDB is measured with `fake-indexeddb`, beside the engine's own tests. The shell is the mail frame now
 * (`MailFrame` of the web's `browser-mail`, which every browser host mounts): the host the gate hands it is captured,
 * and what the old shell's props carried is read off it (its engine, the notice of the account's strip). The way out
 * is the Account section's door the gate hands Settings (`PAIRED_PANE_PARTS.account.useDoor`): the gate's own pane
 * (`HostAccountPane`, still handed as `features.account`) is drawn by nothing; the section's question before the
 * sign-out is the section's own case (`packages/app/test/mail/settings.test.tsx`, "on a browser signed in to
 * somebody's computer it is the sign-out alone, which asks first").
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

/** A notice the frame says, as a feature hands it. */
type FrameNotice = ReturnType<NonNullable<FeatureEntry["notice"]>>[number];
let host: HostContract | null = null;
/** What the old shell was handed, read off the host the frame is handed. */
const shellProps = {
  get engine(): OhmailEngine { return host!.engine as unknown as OhmailEngine; },
  get accountNotice(): (() => readonly FrameNotice[]) | undefined { return (host!.features.accountStrip as FeatureEntry).notice; },
};
let pairProps: ({ onPaired: () => void } & Record<string, unknown>) | null = null;
/** Every discard the gate asked for, in order: `undefined` is every pairing's. */
let discards: Array<{ except?: string | null } | undefined> = [];

/** A part a case stands where the frame stands, under what the gate stands around it; none by default. */
let probe: (() => null) | null = null;

vi.mock("../../webapp/app/shell/browser-mail", async (load) => ({
  ...(await load<object>()),
  MailFrame: (props: { host: HostContract }) => { host = props.host; return probe === null ? null : h(probe); },
}));
/* As the old shell's stand-in did: nothing below the gate drives the engine; the cases drive it themselves. */
vi.mock("../../webapp/app/shell/engine", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/shell/engine")>("../../webapp/app/shell/engine");
  return { ...real, EngineProvider: ({ children }: { children: React.ReactNode }) => children };
});
vi.mock("../../paired-page/src/PairScreen.js", async () => {
  const real = await vi.importActual<typeof import("../../paired-page/src/PairScreen.js")>(
    "../../paired-page/src/PairScreen.js",
  );
  return {
    ...real,
    PairScreen: (props: { onPaired: () => void } & Record<string, unknown>) => { pairProps = props; return null; },
  };
});
vi.mock("../../paired-page/src/outbox-store.js", async () => {
  const real = await vi.importActual<typeof import("../../paired-page/src/outbox-store.js")>(
    "../../paired-page/src/outbox-store.js",
  );
  return {
    ...real,
    discardHostOutbox: (opts?: { except?: string | null }) => { discards.push(opts); return real.discardHostOutbox(opts); },
  };
});

type Mode = "away" | "revoked" | "home";
let mode: Mode;
/** What reached the computer in the `home` mode: the path and the bearer it carried. */
let reached: Array<[string, string | null]> = [];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function pairedBearer(): BearerManager {
  const bearer = new BearerManager({
    storage: window.localStorage,
    fetchImpl: (async (url: string, init?: { headers?: Record<string, string> }) => {
      if (mode === "away") throw new TypeError("Failed to fetch");
      if (mode === "home") {
        reached.push([url, init?.headers?.authorization ?? null]);
        return new Response(null, { status: 204 });
      }
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

/** A notice the frame would say: its title and its answers, as the slot draws them. */
function Said({ notice }: { notice: () => readonly FrameNotice[] }) {
  const said = notice();
  return h("div", null, ...said.map((n, i) => h("p", { key: i }, n.title, ...(n.acts ?? []).map((a) => h("button", { key: a.label, type: "button", onClick: a.onPress }, a.label)))));
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
  reached = [];
  host = null;
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
    expect(await textOf(h(Said, { notice: notice! }))).toContain(messages.pairLanding.outboxNotKept);

    // Dismissed, it stays away for this pairing.
    const el = document.createElement("div");
    document.body.append(el);
    const r = createRoot(el);
    await act(async () => {
      r.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(Said, { notice: notice! }) }));
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

/**
 * THE PAIRED BROWSER'S OWN SIGN OUT. Settings → Account here is the gate's pane: one press with a
 * confirm, the computer told with this browser's bearer, what this browser kept for the pairing
 * gone with it, and the landing saying what happened at the computer rather than "the pairing ended".
 */
describe("Sign out on the paired browser", () => {
  /** The Account section's door the gate hands Settings, read where the frame stands: armed before the mount. */
  let door: ReturnType<typeof PAIRED_PANE_PARTS.account.useDoor> | null = null;
  function armDoor(): void {
    door = null;
    probe = () => { door = PAIRED_PANE_PARTS.account.useDoor(); return null; };
  }
  afterEach(() => { probe = null; door = null; });
  /**
   * Sign out as the Account section does once its question is answered: through the gate's door. (The question
   * first is the section's: `settings.test.tsx`, "… it is the sign-out alone, which asks first".)
   */
  async function pressSignOut(): Promise<void> {
    expect(door, "the paired browser has no Sign out").not.toBeNull();
    await act(async () => { await door!.signOut(); });
    await ticks();
  }

  async function landing(): Promise<string> {
    const real = await vi.importActual<typeof import("../../paired-page/src/PairScreen.js")>("../../paired-page/src/PairScreen.js");
    return textOf(h(real.PairScreen, pairProps as unknown as Parameters<typeof real.PairScreen>[0]));
  }

  it("tells the computer with this browser's bearer, and what it kept goes with the pairing", async () => {
    mode = "home";
    const bearer = pairedBearer();
    armDoor();
    await mount(bearer);
    const draft = `${COMPOSE_DRAFT_PREFIX}${bearer.pairScope()}.c1`;
    window.localStorage.setItem(draft, "half a letter");
    await pressSignOut();
    expect(reached).toEqual([["/auth/logout", "Bearer a1"]]);
    expect(bearer.paired()).toBe(false);
    expect(window.localStorage.getItem(draft), "the scratch outlived the sign-out").toBeNull();
    expect(discards).toEqual([undefined]);
    expect(pairProps).toMatchObject({ ended: "signed-out", signedOut: "told" });
    const said = await landing();
    expect(said).toContain(messages.pairLanding.signedOutBody);
    expect(said).not.toContain(messages.pairLanding.revokedBody);
  });

  /* The new shell's Account section (the sign-out alone) signs out through this door; its question first, its Cancel
     and its Confirm are the section's own (`packages/app/test/mail/settings.test.tsx`). */
  it("the Account section's door is the pairing's own sign-out: it ends the pairing as this page's Sign out does, and asks nobody who is signed in", async () => {
    mode = "home";
    const bearer = pairedBearer();
    let door: ReturnType<typeof PAIRED_PANE_PARTS.account.useDoor> | null = null;
    probe = () => { door = PAIRED_PANE_PARTS.account.useDoor(); return null; };
    try {
      await mount(bearer);
      expect(await door!.who()).toEqual({ ok: false, word: "signed_out" });
      expect(reached, "who is signed in was asked of the computer").toEqual([]);
      let answered: string | null = null;
      await act(async () => { answered = await door!.signOut(); });
      await ticks();
      expect(answered, "the page's landing is the answer: the door says the browser left").toBe("left");
      expect(reached).toEqual([["/auth/logout", "Bearer a1"]]);
      expect(bearer.paired()).toBe(false);
      expect(pairProps).toMatchObject({ ended: "signed-out", signedOut: "told" });
    } finally {
      probe = null;
    }
  });

  it("with the computer out of reach the sign-out is owed, and the landing says it will be told", async () => {
    const bearer = pairedBearer();
    armDoor();
    await mount(bearer);
    await pressSignOut();
    expect(bearer.paired()).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(OWED_SIGN_OUTS_STORAGE_KEY)!)).toMatchObject([{ token: "r1" }]);
    expect(pairProps).toMatchObject({ ended: "signed-out", signedOut: "owed" });
    expect(await landing()).toContain(messages.pairLanding.signedOutOwedBody);
  });

  it("control: a pairing ended from the computer still lands on the pairing-ended sentence", async () => {
    const bearer = pairedBearer();
    await mount(bearer);
    mode = "revoked";
    await act(async () => { await (shellProps!.engine as OhmailEngine).syncOnce().catch(() => undefined); });
    await ticks();
    expect(pairProps).toMatchObject({ ended: "revoked" });
    expect(await landing()).toContain(messages.pairLanding.revokedBody);
  });
});
