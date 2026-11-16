/** @vitest-environment jsdom */

/**
 * THE CONSENT ROW'S REMEMBERED ANSWER IS KEPT FOR THE SCOPE ITS MOUNT WAS HANDED, read once as it mounts. Whatever
 * the session's marker or the storage owner come to say while the mount stands, an answer and a folders echo are
 * remembered for the account that asked, and for nobody under no scope, under the demo's, or after the mount has gone.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConsentStateWire } from "@ohmail/app-logic/consent/consent-wire";
import { bootCacheKey } from "@ohmail/app-logic/session/boot-cache";
import { OWNER_COOKIE } from "@ohmail/app-logic/storage/owner-cookie";
import type { StorageScope } from "@ohmail/app-logic/storage/scope";
import {
  DEMO_STORAGE_OWNER,
  namesOwner,
  resetStorageOwnerForTest,
  setDemoStorage,
  setStorageOwner,
} from "@ohmail/app-logic/storage/storage-owner";
import { useConsentState, type ConsentTransport } from "@ohmail/app-logic/consent/consent-state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISO = "2026-08-27T09:00:00.000Z";
const STAMP = "2026-08-27T10:30:00.000Z";
const A = "acct_scope_a";
const B = "acct_scope_b";

type Row = ReturnType<typeof useConsentState>;

interface Held<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function held<T>(): Held<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A wire whose read and whose folders press are held until the case lets them go; every call is counted. */
function heldWire(): {
  transport: ConsentTransport;
  reads: Array<Held<ConsentStateWire>>;
  folders: Array<Held<{ foldersEnabledAt: string | null }>>;
  calls: string[];
} {
  const reads: Array<Held<ConsentStateWire>> = [];
  const folders: Array<Held<{ foldersEnabledAt: string | null }>> = [];
  const calls: string[] = [];
  const unused = (name: string) => (): Promise<never> => {
    calls.push(name);
    return Promise.reject(new Error(`unused: ${name}`));
  };
  const transport: ConsentTransport = {
    foldersStorable: true,
    state: () => {
      calls.push("state");
      reads.push(held<ConsentStateWire>());
      return reads[reads.length - 1]!.promise;
    },
    setFoldersEnabled: () => {
      calls.push("setFoldersEnabled");
      folders.push(held<{ foldersEnabledAt: string | null }>());
      return folders[folders.length - 1]!.promise;
    },
    setAutoSuggest: unused("setAutoSuggest"),
    setDormancyDays: unused("setDormancyDays"),
    setBlockRemoteImages: unused("setBlockRemoteImages"),
    setBlockTrackingPixels: unused("setBlockTrackingPixels"),
    setBlockAutoUnsubscribe: unused("setBlockAutoUnsubscribe"),
    setMailboxFoldersEnabled: unused("setMailboxFoldersEnabled"),
    setMailboxSignature: unused("setMailboxSignature"),
  };
  return { transport, reads, folders, calls };
}

const ANSWER: ConsentStateWire = { seedConfirmedAt: ISO, dormancyDays: 45, foldersEnabledAt: null };
/** What an answer leaves for the next boot: four fields that authorise nothing. */
const REMEMBERED = { v: 1, seedConfirmedAt: ISO, dormancyDays: 45, screeningBaselineAt: null, foldersEnabledAt: null };

const remember = (scope: string, dormancyDays: number): void => {
  window.localStorage.setItem(
    bootCacheKey("consent", scope),
    JSON.stringify({ v: 1, seedConfirmedAt: ISO, dormancyDays, screeningBaselineAt: null, foldersEnabledAt: null }),
  );
};
const remembered = (scope: string): unknown => {
  const raw = window.localStorage.getItem(bootCacheKey("consent", scope));
  return raw === null ? null : JSON.parse(raw);
};
const keys = (): string[] =>
  Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!).sort();
const bootKeys = (): string[] => keys().filter((key) => key.startsWith("ohmail.boot."));
const keysNaming = (scope: string): string[] => keys().filter((key) => namesOwner(key, scope, true));
/** Everything this browser keeps, key by key. */
const kept = (): string => JSON.stringify(keys().map((key) => [key, window.localStorage.getItem(key)]));

/** The session's marker and the storage owner both come to name another account, as another tab's sign-in does. */
const jarNames = (account: string): void => {
  document.cookie = `${OWNER_COOKIE}=${account}; path=/`;
  setStorageOwner(account);
};

let row: Row | null = null;
function Probe(props: { scope: StorageScope; wire: ConsentTransport }): null {
  row = useConsentState(true, props.scope, props.wire);
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

async function mount(scope: StorageScope, wire: ConsentTransport, key = "one"): Promise<void> {
  if (root === null) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(
      <Catch onError={(e) => errors.push(e)}>
        <Probe key={key} scope={scope} wire={wire} />
      </Catch>,
    );
  });
  await flush();
}
async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
}
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};

beforeEach(() => {
  errors.length = 0;
  window.localStorage.clear();
  resetStorageOwnerForTest();
  document.cookie = `${OWNER_COOKIE}=; path=/; max-age=0`;
});
afterEach(async () => {
  await unmount();
  row = null;
  resetStorageOwnerForTest();
  document.cookie = `${OWNER_COOKIE}=; path=/; max-age=0`;
  window.localStorage.clear();
});

describe("the consent row's remembered answer is its mount's scope's", () => {
  it("an answer that lands after the jar came to name another account is remembered for the one that asked", async () => {
    jarNames(A);
    const wire = heldWire();
    await mount(A, wire.transport);
    expect(wire.reads).toHaveLength(1);

    jarNames(B);
    await act(async () => wire.reads[0]!.resolve(ANSWER));
    await flush();

    expect(row!.dormancyDays).toBe(45);
    expect(remembered(A)).toEqual(REMEMBERED);
    expect(keysNaming(B)).toEqual([]);
  });

  it("a folders echo that lands after the jar moved stamps its own account's row and copies it nowhere", async () => {
    jarNames(A);
    remember(A, 60);
    const wire = heldWire();
    await mount(A, wire.transport);

    let pressed: Promise<boolean> | null = null;
    await act(async () => {
      pressed = row!.setFoldersEnabled(true);
    });
    jarNames(B);
    await act(async () => {
      wire.folders[0]!.resolve({ foldersEnabledAt: STAMP });
      await pressed;
    });

    expect(remembered(A)).toEqual({ ...REMEMBERED, dormancyDays: 60, foldersEnabledAt: STAMP });
    expect(keysNaming(B)).toEqual([]);
  });

  it("a mount for one account reads its own remembered row while the marker names another", async () => {
    document.cookie = `${OWNER_COOKIE}=${B}; path=/`;
    setStorageOwner(A);
    remember(B, 7);
    remember(A, 60);
    await mount(A, heldWire().transport);

    expect(row!.known).toBe(true);
    expect(row!.dormancyDays).toBe(60);
  });

  it("a press from a mount whose jar already names another account goes out once and stamps its own row", async () => {
    jarNames(A);
    remember(A, 60);
    const wire = heldWire();
    await mount(A, wire.transport);
    jarNames(B);

    let pressed: Promise<boolean> | null = null;
    await act(async () => {
      pressed = row!.setFoldersEnabled(true);
    });
    expect(wire.calls.filter((call) => call === "setFoldersEnabled")).toHaveLength(1);
    await act(async () => {
      wire.folders[0]!.resolve({ foldersEnabledAt: STAMP });
      expect(await pressed).toBe(true);
    });

    expect(row!.foldersEnabled).toBe(true);
    expect(remembered(A)).toEqual({ ...REMEMBERED, dormancyDays: 60, foldersEnabledAt: STAMP });
    expect(keysNaming(B)).toEqual([]);
  });

  it("under the demo's scope nothing is remembered, whoever the marker names", async () => {
    document.cookie = `${OWNER_COOKIE}=${A}; path=/`;
    setDemoStorage(true);
    remember(A, 60);
    const before = kept();
    const wire = heldWire();
    await mount(DEMO_STORAGE_OWNER, wire.transport);
    expect(row!.known, "the demo read a remembered row").toBe(false);

    await act(async () => wire.reads[0]!.resolve(ANSWER));
    await flush();
    expect(row!.dormancyDays).toBe(45);
    expect(kept()).toBe(before);
  });

  it("under no scope nothing is remembered and nothing is read, the shared word included", async () => {
    window.localStorage.setItem(
      "ohmail.boot.consent.local",
      JSON.stringify({ v: 1, seedConfirmedAt: ISO, dormancyDays: 7, screeningBaselineAt: null, foldersEnabledAt: ISO }),
    );
    const wire = heldWire();
    await mount(null, wire.transport);
    expect(row!.known, "a row under the shared word was applied").toBe(false);

    window.localStorage.clear();
    await act(async () => wire.reads[0]!.resolve(ANSWER));
    await flush();
    expect(row!.dormancyDays).toBe(45);
    let pressed: Promise<boolean> | null = null;
    await act(async () => {
      pressed = row!.setFoldersEnabled(true);
    });
    await act(async () => {
      wire.folders[0]!.resolve({ foldersEnabledAt: STAMP });
      await pressed;
    });
    expect(bootKeys()).toEqual([]);
    expect(keys().filter((key) => key.endsWith("local"))).toEqual([]);
  });

  it("an answer and an echo that land after the mount has gone are remembered nowhere", async () => {
    jarNames(A);
    const reading = heldWire();
    await mount(A, reading.transport);
    await unmount();
    await act(async () => reading.reads[0]!.resolve(ANSWER));
    await flush();
    expect(bootKeys()).toEqual([]);

    remember(A, 60);
    const pressing = heldWire();
    await mount(A, pressing.transport);
    const press = row!.setFoldersEnabled(true);
    await flush();
    await unmount();
    await act(async () => {
      pressing.folders[0]!.resolve({ foldersEnabledAt: STAMP });
      await press;
    });
    expect(remembered(A)).toEqual({ ...REMEMBERED, dormancyDays: 60 });
  });

  it("a mounted row handed another scope throws, and so does one handed none at all", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const wire = heldWire().transport;
      await mount(A, wire);
      await mount(B, wire);
      expect(errors.map((e) => e.message)).toEqual(["ohmail: a mounted hook was handed another storage scope"]);
      expect(bootKeys()).toEqual([]);

      for (const missing of [undefined, ""]) {
        await unmount();
        errors.length = 0;
        await mount(missing as unknown as StorageScope, wire);
        expect(errors, `mounted with ${JSON.stringify(missing)}`).toHaveLength(1);
        expect(errors[0]!.message).toMatch(/storage scope/);
      }
    } finally {
      console.error = quiet;
    }
  });
});
