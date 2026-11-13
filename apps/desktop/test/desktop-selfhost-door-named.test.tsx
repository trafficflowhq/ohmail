/** @vitest-environment jsdom */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, createTranslator } from "next-intl";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog, setActiveFormatZone } from "../../webapp/app/shell/locale";
import { ManagedServiceContext } from "../../webapp/app/shell/managed-service";
import { desktopFiler } from "../../webapp/app/shell/mail-state";
import { DOOR_COPY } from "../src/door-copy.js";
import { CLOUD_URL, flavorOf, isManagedDoor } from "../src/doors.js";
import { cloudSessionNotice } from "../src/cloud-session.js";
import { DesktopAbout } from "../src/DesktopAbout.js";
import { DesktopSettings } from "../src/DesktopSettings.js";
import { DesktopScreening } from "../src/DesktopScreening.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { readMailboxFactsVia } from "../src/mailbox-facts-wire.js";
import { createCloudSidecar } from "../../sidecar/src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "../../sidecar/test/fixtures/hosted-mailbox.js";

/* jsdom's `Blob` has no `arrayBuffer()`; PGlite hands its extensions over as one. A gap in the TEST
   environment only, shimmed as `desktop-first-cloud-door.test.tsx` does. */
if (typeof (Blob.prototype as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
  (Blob.prototype as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer =
    function (this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as ArrayBuffer);
        fr.onerror = () => reject(fr.error);
        fr.readAsArrayBuffer(this);
      });
    };
}

/**
 * A DOOR IS NAMED BY THE SERVER IT READS. The self-hosted door records no flavor — only the paired
 * door writes one — so every door sentence read it as the managed service: Settings → Desktop said
 * "ohmail Cloud", About "An ohmail Cloud account" and "our servers", the rail "ohmail Cloud could not
 * be reached" and the Screener's offline notes "your ohmail Cloud account", all about somebody's own
 * server. The origin decides, by the shell's own rule; the managed origin keeps its words (control).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const host = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };

const door = (cloudUrl: string | undefined, over: Partial<EngineStatus> = {}): EngineStatus => ({
  state: "serving", mode: "cloud", credentialState: "ready", address: "me@ohmail.test", mailboxId: "mbx-1",
  ...(cloudUrl === undefined ? {} : { cloudUrl }), ...over,
} as EngineStatus);
const MANAGED = door(CLOUD_URL);
const SELF_HOSTED = door("https://mail.example.com");
const GERMAN = fillFrom(en as never, de as never) as never;

let hostEl: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  hostEl?.remove();
  hostEl = null;
  setActiveCatalog(DEFAULT_LOCALE, null);
  delete host.__TAURI_INTERNALS__;
});

async function render(node: React.ReactNode, locale: "en" | "de" = "en"): Promise<string> {
  if (locale === "de") setActiveCatalog("de", GERMAN);
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "en" ? en : de) as never, timeZone: "UTC", children: node,
    }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return hostEl.textContent ?? "";
}

describe("which server a cloud door reads — the origin, by the shell's rule", () => {
  it("names each door, and a door with no readable origin keeps the shipped answer", () => {
    expect(flavorOf(MANAGED)).toBe("managed");
    expect(flavorOf(door("https://API.ohmail.app./"))).toBe("managed");
    expect(flavorOf(SELF_HOSTED)).toBe("selfhost");
    expect(flavorOf(door("https://mail.example.com", { flavor: "desktop-host" }))).toBe("desktop-host");
    expect(flavorOf(door(undefined))).toBe("unknown");
    expect(isManagedDoor(MANAGED)).toBe(true);
    expect(isManagedDoor(door(undefined))).toBe(true);
    expect(isManagedDoor(SELF_HOSTED)).toBe(false);
    expect(isManagedDoor(door("https://desk.example", { flavor: "desktop-host" }))).toBe(false);
    expect(isManagedDoor({ state: "serving", mode: "local" } as EngineStatus)).toBe(false);
  });

  /* The Mailboxes pane's heading keys on the same reading: a real self-hosted door now reaches its
     "Mailboxes on this server" row, which a flavor no door writes kept out of reach. */
  it("the Mailboxes pane files a self-hosted door as the server", () => {
    expect(desktopFiler("cloud", flavorOf(SELF_HOSTED))).toBe("server");
    expect(desktopFiler("cloud", flavorOf(MANAGED))).toBe("cloud");
  });
});

describe("Settings → Desktop and About name the door by its server", () => {
  const settings = (status: EngineStatus) => h(DesktopSettings, {
    status, session: "live", sealFailed: false,
    onStatus: () => undefined, onSwitchDoor: () => undefined, onSignIn: () => undefined,
  });

  it("CONTROL — the managed door is ohmail Cloud in both panes", async () => {
    expect(await render(settings(MANAGED))).toContain(DOOR_COPY.doorCloudName);
    await act(async () => { root!.unmount(); });
    const about = await render(h(DesktopAbout, { status: MANAGED }));
    expect(about).toContain(DOOR_COPY.aboutDoorCloudValue);
    expect(about).toContain(DOOR_COPY.aboutDoorCloudWhy);
    expect(about).toContain(DOOR_COPY.aboutLinksCloud);
  });

  it.each(["en", "de"] as const)("%s: a self-hosted door is the person's server, never ohmail Cloud", async (locale) => {
    const pane = await render(settings(SELF_HOSTED), locale);
    expect(pane).toContain(DOOR_COPY.doorServerNamed);
    expect(pane).not.toMatch(/ohmail[ -]Cloud/);
    await act(async () => { root!.unmount(); });
    const about = await render(h(DesktopAbout, { status: SELF_HOSTED }), locale);
    expect(about).toContain(DOOR_COPY.aboutDoorServerValue);
    expect(about).toContain(DOOR_COPY.aboutDoorServerWhy);
    expect(about).toContain(DOOR_COPY.aboutLinksLocal);
    expect(about).not.toMatch(/ohmail[ -]Cloud/);
  });
});

describe("the rail and the Screener's offline notes name the door's server", () => {
  it("the rail's unreachable line", () => {
    const reading = { state: "unreachable", code: null, since: "2026-09-27T00:00:00.000Z" } as never;
    expect(cloudSessionNotice(reading)?.words.title).toBe(DOOR_COPY.cloudUnreachableTitle);
    expect(cloudSessionNotice(reading, false)?.words.title).toBe(DOOR_COPY.serverUnreachableTitle);
    expect(DOOR_COPY.serverUnreachableTitle).not.toMatch(/Cloud/);
  });

  /** The engine answers 503 for the preference: the hosted account cannot be reached. */
  function offlineEngine(): void {
    const meta = new TextEncoder().encode(JSON.stringify({ status: 503, statusText: "Service Unavailable", h: [] }));
    const out = new Uint8Array(4 + meta.byteLength);
    new DataView(out.buffer).setUint32(0, meta.byteLength, false);
    out.set(meta, 4);
    host.__TAURI_INTERNALS__ = { invoke: async (command) => {
      if (command === "engine_request") return out;
      throw new Error(`unexpected ${command}`);
    } };
  }

  it.each([true, false])("managed %s: the offline note names the account or the server", async (managed) => {
    offlineEngine();
    const text = await render(h(ManagedServiceContext.Provider, {
      value: managed, children: h(DesktopScreening, { door: "cloud" }),
    }));
    expect(text).toContain(managed ? en.desktopScreener.offlineNote : en.desktopScreener.offlineNoteServer);
    if (!managed) expect(text).not.toMatch(/Cloud/);
  });
});

/**
 * NEW MAIL IS LATE, IN THE WINDOW OF AN ACCOUNT ON A SERVER. The window reads its mailbox rows from
 * the engine on this computer, never from the server, and hands the shared shell whether the door's
 * server is the managed service. So the rows here are what that door REALLY answers: a hosted-door
 * engine is started once over a server whose mailboxes each carry a different word, and the strip is
 * drawn from its answer. It arrives when the server says it is not fetching, leaves when it says it
 * is, names ohmail Cloud only behind the managed origin, and shows nothing where no word arrives.
 *
 * Mutations watched red: the engine's door not carrying the server's word (nothing is drawn on any
 * door); the narrowing dropping `fetching` (the same); `isManagedDoor` answering true for the
 * self-hosted door (it says Cloud).
 */
describe("the window's sync strip says when its server is not fetching new mail", () => {
  const NOW = new Date("2026-11-13T12:00:00.000Z");
  const SINCE = "2026-11-13T11:10:00.000Z";
  const tEn = createTranslator({ locale: "en", messages: en as never, namespace: "sync" as never }) as unknown as
    (key: string, values?: Record<string, string | number>) => string;
  /** What the server says on each mailbox's row; `older` is a server that sends no such key. */
  const SAID = {
    behind: { behind: true, since: SINCE },
    runs: { behind: false, since: NOW.toISOString() },
    silent: null,
    older: "absent",
  } as const;
  type Word = keyof typeof SAID;
  const WORDS = Object.keys(SAID) as Word[];
  const boxId = (word: Word): string => `cccccccc-cccc-4ccc-8ccc-ccccccccccc${WORDS.indexOf(word)}`;
  /** One mailbox row per word, as the window's own door answered it. */
  const door = {} as Record<Word, Record<string, unknown>>;

  beforeAll(async () => {
    const listed = WORDS.map((word, i) => {
      const row = hostedMailbox(boxId(word), i === 0 ? "me@ohmail.test" : `${word}@ohmail.test`, { lastSyncAt: SINCE });
      if (SAID[word] === "absent") {
        const { fetching: _drop, ...rest } = row;
        return rest as typeof row;
      }
      return { ...row, fetching: SAID[word] as typeof row.fetching };
    });
    const send = (v: unknown): Response =>
      new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-late-door-"));
    const engine = await createCloudSidecar({
      dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test", tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl: (async (input: string | URL | Request) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
        if (path.startsWith("/mailboxes")) return send(mailboxList(listed));
        if (path.startsWith("/sync/snapshot")) return send({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
        if (path.startsWith("/sync")) {
          return send({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "end", hasMore: false, serverTime: new Date().toISOString() });
        }
        if (path.startsWith("/messages/bodies")) return send({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch,
      pollIntervalMs: 3_600_000,
    });
    try {
      await engine.start();
      const res = await engine.handle(new Request("http://sidecar/mailboxes", {
        headers: { authorization: `Bearer ${engine.sessionToken}` },
      }));
      const items = ((await res.json()) as { items: Array<Record<string, unknown>> }).items;
      for (const word of WORDS) door[word] = items.find((r) => r.id === boxId(word))!;
    } finally {
      await engine.stop().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  let served: Record<string, unknown>[] = [];

  afterEach(() => { setActiveFormatZone(null); vi.useRealTimers(); });

  async function strip(status: EngineStatus): Promise<{ said: () => string; nextPoll: () => Promise<void> }> {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setActiveFormatZone("UTC");
    const { MemoryMirrorStore, OhmailEngine } = await import("@ohmail/client-engine");
    const { EngineProvider } = await import("../../webapp/app/shell/engine");
    const { MailStateProvider, FACTS_POLL_MS } = await import("../../webapp/app/shell/MailStateProvider");
    const { SyncBar } = await import("../../webapp/app/shell/SyncBar");
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = new OhmailEngine({
      store, now: () => NOW,
      adapter: {
        sync: async () => ({
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        }),
        mutate: async () => ({ changes: [], seq: null }),
        fetchBody: async () => null,
      } as never,
    });
    /* The window's own read of the list, over the rows its door answered. */
    const probe = () => readMailboxFactsVia(async () =>
      new Response(JSON.stringify({ items: served }), { status: 200, headers: { "content-type": "application/json" } }));
    hostEl = document.createElement("div");
    document.body.append(hostEl);
    root = createRoot(hostEl);
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
    };
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages: en as never, timeZone: "UTC", now: NOW,
        children: h(ManagedServiceContext.Provider, {
          value: isManagedDoor(status),
          children: h(EngineProvider as never, {
            demo: false, engine,
            children: h(MailStateProvider as never, { probe, mirrored: 12, children: h(SyncBar, { variant: "rail" }) } as never),
          } as never),
        }),
      } as never));
    });
    await settle();
    return {
      said: () => hostEl!.querySelector('[role="status"]')?.textContent ?? "",
      nextPoll: async () => {
        await act(async () => { await vi.advanceTimersByTimeAsync(FACTS_POLL_MS + 50); });
        await settle();
      },
    };
  }

  it("the door answered each mailbox with the server's own word, or with none", () => {
    expect(door.behind.fetching).toEqual(SAID.behind);
    expect(door.runs.fetching).toEqual(SAID.runs);
    expect(door.silent.fetching).toBeNull();
    expect(door.older.fetching).toBeNull();
  });

  it("the managed door: it arrives with the server's time, and leaves when fetching runs again", async () => {
    served = [door.behind];
    const win = await strip(MANAGED);
    expect(win.said()).toContain(tEn("behindTitle"));
    expect(win.said()).toContain(tEn("behindLineCloud", { hasSince: "yes", since: "11:10" }));
    served = [door.runs];
    await win.nextPoll();
    expect(hostEl!.textContent ?? "").toBe("");
  });

  it("a self-hosted door names your ohmail server, never ohmail Cloud", async () => {
    served = [door.behind];
    const win = await strip(SELF_HOSTED);
    expect(win.said()).toContain(tEn("behindLineServer", { hasSince: "yes", since: "11:10" }));
    expect(hostEl!.textContent ?? "").not.toMatch(/Cloud/);
  });

  /* A computer that organizes on its own reads the same store with no server behind it: its rows
     carry `null`, as the rows of a server that sends no word do. */
  it.each([
    ["this computer organizes on its own", { state: "serving", mode: "local" } as EngineStatus, "older"],
    ["a server that does not say", MANAGED, "silent"],
    ["an older server sends no such key", MANAGED, "older"],
  ] as Array<[string, EngineStatus, Word]>)("says nothing when %s", async (_what, status, word) => {
    served = [door[word]];
    const win = await strip(status);
    await win.nextPoll();
    expect(hostEl!.textContent ?? "").toBe("");
  });
});
