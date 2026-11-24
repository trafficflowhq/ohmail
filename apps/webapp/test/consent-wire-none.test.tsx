/** @vitest-environment jsdom */

/**
 * A HOST THAT SAYS `none` HAS NO CONSENT WIRE, and the consent row then asks no server and writes to none, on a page
 * whose own client is configured and signed in. Nothing is chosen for a host that named nothing: a wire nobody
 * handed in is refused at the mount.
 *
 * And what a wire does answer never widens pictures by itself: a read that failed, an answer from before the field
 * existed, a refused press and an echo of a wire that has gone all leave pictures on the per-letter press.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DORMANCY_DAYS } from "@ohmail/client-engine";
import type { ConsentStateWire } from "@ohmail/app-logic/consent/consent-wire";
import { bootCacheKey } from "@ohmail/app-logic/session/boot-cache";
import { OWNER_COOKIE } from "@ohmail/app-logic/storage/owner-cookie";
import { useConsentState, type ConsentTransport } from "@ohmail/app-logic/consent/consent-state";

/* The page's own client is configured before any module reads it: a request for the consent row COULD leave here. */
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_BASE = "/api";
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISO = "2026-08-27T09:00:00.000Z";
/** The account this browser is signed in as, and the scope every mount below is handed unless it names another. */
const ACCOUNT = "acct_none_1";
const ANOTHER = "acct_none_2";

type Row = ReturnType<typeof useConsentState>;
type Wire = ConsentTransport | "none";

/** The row a mounted shell holds while nobody has answered: what `none` presents for good. */
const AT_REST = {
  seedConfirmedAt: null,
  dormancyDays: DEFAULT_DORMANCY_DAYS,
  screeningBaselineAt: null,
  autoSuggest: false,
  suggestionConsentKnown: false,
  suggestionGrant: 0,
  relaySuggestionGrant: null,
  autoSuggestAt: null,
  autoAct: false,
  autoActAt: null,
  autoActStorable: false,
  blockRemoteImages: true,
  remoteImagesKnown: false,
  blockRemoteImagesAt: null,
  blockTrackingPixels: true,
  trackingPixelsKnown: false,
  loadTrackingPixelsAt: null,
  autoUnsubscribe: true,
  blockAutoUnsubscribeAt: null,
  acknowledgeScreener: null,
  screenerAcknowledgements: 0,
  foldersEnabled: false,
  foldersEnabledAt: null,
  folderMailboxesOff: {},
  folderMailboxesKnown: false,
  signatures: {},
  signaturesHtml: {},
  signatureSources: {},
  signatureChanges: {},
  dormancyChange: null,
  signaturesKnown: false,
  locale: null,
  themeFace: null,
  themeFaceKnown: false,
  resurfaceTime: null,
  draftReplies: null,
  known: false,
  foldersStorable: false,
  onboardingCompletedAt: null,
  onboardingKnown: false,
  screeningScope: "window",
  screeningByMailbox: null,
};

/** The eight presses every wire carries, each as a person would make it. */
const WRITERS: ReadonlyArray<readonly [string, (row: Row) => Promise<unknown>]> = [
  ["setAutoSuggest", (row) => row.setAutoSuggest(true)],
  ["setDormancyDays", (row) => row.setDormancyDays(30)],
  ["setBlockRemoteImages", (row) => row.setBlockRemoteImages(false)],
  ["setBlockTrackingPixels", (row) => row.setBlockTrackingPixels(false)],
  ["setBlockAutoUnsubscribe", (row) => row.setBlockAutoUnsubscribe(true)],
  ["setFoldersEnabled", (row) => row.setFoldersEnabled(true)],
  ["setMailboxFoldersEnabled", (row) => row.setMailboxFoldersEnabled("mb_1", false)],
  ["setMailboxSignature", (row) => row.setMailboxSignature("mb_1", "Kind regards")],
];

/** What a row says, without its presses and without the one field that follows `active`. */
function saidBy(row: Row): Record<string, unknown> {
  const said: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "function" && key !== "standalone" && !key.startsWith("set")) said[key] = value;
  }
  return said;
}

let row: Row | null = null;
function Probe(props: { active: boolean; scope: string; wire: Wire }): null {
  row = useConsentState(props.active, props.scope, props.wire);
  return null;
}

class Catch extends React.Component<{ children?: React.ReactNode; onError: (e: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(e: Error): void {
    this.props.onError(e);
  }
  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const errors: Error[] = [];

async function mount(active: boolean, wire: Wire, key = "one", scope = ACCOUNT): Promise<void> {
  if (root === null) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(
      <Catch onError={(e) => errors.push(e)}>
        <Probe key={key} active={active} scope={scope} wire={wire} />
      </Catch>,
    );
  });
  await flush();
}

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};

/** Every request this page sent, by method and path. */
let sent: string[] = [];
let pageFetch: typeof globalThis.fetch;

/** The account's stored row as the page's own server would answer it: pictures load, folders on, suggestions on. */
const STORED = {
  seedConfirmedAt: ISO,
  screeningResetAt: null,
  dormancyDays: 45,
  autoSuggestAt: ISO,
  blockRemoteImagesAt: null,
  loadTrackingPixelsAt: ISO,
  foldersEnabledAt: ISO,
  folderMailboxesOff: {},
  signatures: { mb_1: "Kind regards" },
};

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  errors.length = 0;
  window.localStorage.clear();
  document.cookie = `${OWNER_COOKIE}=${ACCOUNT}; path=/`;
  pageFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response(JSON.stringify(STORED), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  row = null;
  globalThis.fetch = pageFetch;
  document.cookie = `${OWNER_COOKIE}=; path=/; max-age=0`;
  window.localStorage.clear();
  vi.useRealTimers();
});

/** Long enough for every retry of a read and every poll this hook could arm. */
const wait = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400_000);
  });
  await flush();
};

describe("a consent row whose host handed no wire", () => {
  for (const active of [true, false]) {
    it(`reaches no server at its mount or at a press${active ? "" : ", in the demo's shape (not active)"}`, async () => {
      await mount(active, "none");
      await wait();
      expect(sent, "a request left this page at the mount").toEqual([]);

      for (const [name, press] of WRITERS) {
        await expect(press(row!), name).rejects.toThrow("no consent wire stands behind this shell");
      }
      await wait();
      expect(sent, "a press left this page on the browser's own session").toEqual([]);
      expect(saidBy(row!)).toEqual(AT_REST);
    });
  }

  it("rests: the three presses a wire may lack are absent, and no remembered row is read", async () => {
    window.localStorage.setItem(
      bootCacheKey("consent", ACCOUNT),
      JSON.stringify({ v: 1, seedConfirmedAt: ISO, dormancyDays: 7, screeningBaselineAt: ISO, foldersEnabledAt: ISO }),
    );
    await mount(true, "none");
    await wait();
    expect(row!.setThemeFace).toBeNull();
    expect(row!.setResurfaceTime).toBeNull();
    expect(row!.setAutoAct).toBeNull();
    expect(row!.standalone, "an active shell with no wire partitions with the product's own window").toBe(true);
    expect(saidBy(row!)).toEqual(AT_REST);

    await mount(false, "none", "the demo");
    await wait();
    expect(row!.standalone, "the demo is no standalone install").toBe(false);
    expect(saidBy(row!)).toEqual(AT_REST);
    expect(sent).toEqual([]);
  });

  it("refuses to mount with no word about its wire", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      await mount(true, undefined as unknown as Wire);
    } finally {
      console.error = quiet;
    }
    expect(errors.map((e) => e.message)).toEqual(["ohmail: the consent hook was mounted with no word about its wire"]);
    expect(sent).toEqual([]);
  });
});

/* ── pictures ─────────────────────────────────────────────────────────────────────────────────────────────────── */

interface Held<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}
function held<T>(): Held<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ANSWER: ConsentStateWire = { seedConfirmedAt: ISO, dormancyDays: 60 };

/** A wire that answers its read with `read` and refuses every press the case does not name. */
function wireOf(read: () => Promise<ConsentStateWire>, over: Partial<ConsentTransport> = {}): ConsentTransport {
  const unused = (): Promise<never> => Promise.reject(new Error("unused"));
  return {
    foldersStorable: true,
    state: read,
    setAutoSuggest: unused,
    setDormancyDays: unused,
    setBlockRemoteImages: unused,
    setBlockTrackingPixels: unused,
    setBlockAutoUnsubscribe: unused,
    setFoldersEnabled: unused,
    setMailboxFoldersEnabled: unused,
    setMailboxSignature: unused,
    ...over,
  };
}

const pictures = (): { manual: boolean; pixelsBlocked: boolean } => ({
  manual: row!.blockRemoteImages,
  pixelsBlocked: row!.blockTrackingPixels,
});
const MANUAL = { manual: true, pixelsBlocked: true };

describe("pictures never load by a row nobody answered", () => {
  it("a read that fails leaves pictures on the press and pixels refused", async () => {
    await mount(
      true,
      wireOf(() => Promise.reject(Object.assign(new Error("down"), { status: 503 }))),
    );
    await wait();
    expect(row!.known).toBe(false);
    expect(pictures()).toEqual(MANUAL);

    // A 200 that carries no window is no answer either, whatever else it says.
    await mount(true, wireOf(() => Promise.resolve({ blockRemoteImagesAt: null } as unknown as ConsentStateWire)), "no window");
    await wait();
    expect(row!.known).toBe(false);
    expect(pictures()).toEqual(MANUAL);
  });

  it("only an answer that carries the field as null lets pictures load; pixels only by a stored choice", async () => {
    const answers: Array<[string, Partial<ConsentStateWire>, { manual: boolean; pixelsBlocked: boolean }]> = [
      ["a server from before the field", {}, MANUAL],
      ["no stored choice", { blockRemoteImagesAt: null, loadTrackingPixelsAt: null }, { manual: false, pixelsBlocked: true }],
      ["pictures kept on the press", { blockRemoteImagesAt: ISO }, MANUAL],
      ["pixels let through", { blockRemoteImagesAt: null, loadTrackingPixelsAt: ISO }, { manual: false, pixelsBlocked: false }],
    ];
    for (const [name, over, expected] of answers) {
      await mount(true, wireOf(() => Promise.resolve({ ...ANSWER, ...over })), name);
      await flush();
      expect(row!.known, name).toBe(true);
      expect(pictures(), name).toEqual(expected);
    }
  });

  it("a press that is refused, or answered with the stored choice, changes nothing", async () => {
    const refusing = wireOf(() => Promise.resolve({ ...ANSWER, blockRemoteImagesAt: ISO }), {
      setBlockRemoteImages: () => Promise.reject(Object.assign(new Error("refused"), { status: 409 })),
      setBlockTrackingPixels: () => Promise.reject(Object.assign(new Error("refused"), { status: 409 })),
    });
    await mount(true, refusing);
    await flush();
    await expect(row!.setBlockRemoteImages(false)).rejects.toThrow("refused");
    await expect(row!.setBlockTrackingPixels(false)).rejects.toThrow("refused");
    await flush();
    expect(pictures()).toEqual(MANUAL);

    // The server answers 200 and still holds the choice: the row takes the echo, never the argument.
    const keeping = wireOf(() => Promise.resolve({ ...ANSWER, blockRemoteImagesAt: ISO }), {
      setBlockRemoteImages: () => Promise.resolve({ blockRemoteImagesAt: ISO }),
      setBlockTrackingPixels: () => Promise.resolve({ loadTrackingPixelsAt: null }),
    });
    await mount(true, keeping, "keeping");
    await flush();
    await act(async () => {
      expect(await row!.setBlockRemoteImages(false)).toBe(true);
      expect(await row!.setBlockTrackingPixels(false)).toBe(true);
    });
    expect(pictures()).toEqual(MANUAL);
  });

  it("an echo that lands after its mount has gone reaches no later mount", async () => {
    const press = held<{ blockRemoteImagesAt: string | null }>();
    const first = wireOf(() => Promise.resolve({ ...ANSWER, blockRemoteImagesAt: ISO }), {
      setBlockRemoteImages: () => press.promise,
    });
    await mount(true, first, "first");
    await flush();
    let pressed: Promise<boolean> | null = null;
    await act(async () => {
      pressed = row!.setBlockRemoteImages(false);
    });

    // Another mount stands in its place under another scope, its own read not yet answered.
    await mount(true, wireOf(() => new Promise<ConsentStateWire>(() => {})), "second", ANOTHER);
    await act(async () => {
      press.resolve({ blockRemoteImagesAt: null });
      await pressed;
    });
    await flush();
    expect(pictures()).toEqual(MANUAL);
  });

  it("an echo of a wire that went is not waiting in the row when a wire stands again", async () => {
    const press = held<{ blockRemoteImagesAt: string | null }>();
    const first = wireOf(() => Promise.resolve({ ...ANSWER, blockRemoteImagesAt: ISO }), {
      setBlockRemoteImages: () => press.promise,
    });
    await mount(true, first);
    await flush();
    let pressed: Promise<boolean> | null = null;
    await act(async () => {
      pressed = row!.setBlockRemoteImages(false);
    });

    // The same mount, its wire gone (the desktop's door switched over the mounted shell), then the late echo.
    await mount(true, "none");
    await act(async () => {
      press.resolve({ blockRemoteImagesAt: null });
      await pressed;
    });
    await flush();
    expect(pictures()).toEqual(MANUAL);

    // A wire stands again and has not answered: the departed wire's echo must not be the row.
    await mount(true, wireOf(() => new Promise<ConsentStateWire>(() => {})));
    await flush();
    expect(pictures()).toEqual(MANUAL);
  });
});
