/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import {
  CLOUD_NOTICE_GRACE_MS, cloudNoticeDue, sessionOf, sessionReaders, signInCauseOf, type CloudSessionWire,
} from "../src/cloud-session.js";
import { DOOR_COPY, machineWord } from "../src/door-copy.js";
import messages from "../../webapp/messages/en.json";

/**
 * THE SIGN-IN DIALOG OPENS ON A REFUSAL AND SAYS WHICH ONE; A FAULT IS A NOTICE OVER THE MAIL.
 *
 * The engine's `/health.session` says where the hosted session stands. The gate opens the dialog
 * on `sessionExpired` alone (a coded refusal), names the cause in its first sentence, and while
 * Cloud is renewing or not answering keeps the mail on screen with one line in the rail — after a
 * grace, so a blip the engine retries away in a second says nothing.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const reading = (state: CloudSessionWire["state"], code: string | null, sinceMs = 60_000): CloudSessionWire =>
  ({ state, code, since: ago(sinceMs) });

describe("the window's reading of /health.session", () => {
  it("takes the engine's shape and nothing else — an older engine's absence is null, not a fault", () => {
    expect(sessionOf(undefined)).toBeNull();
    expect(sessionOf({ state: "gone", code: null, since: ago(0) })).toBeNull();
    expect(sessionOf({ state: "renewing", since: 5 })).toBeNull();
    expect(sessionOf({ state: "renewing", code: "http_403", since: "2026-09-23T00:00:00.000Z" }))
      .toEqual({ state: "renewing", code: "http_403", since: "2026-09-23T00:00:00.000Z" });
  });

  it("names a cause only for the two refusals and the unreadable seal", () => {
    expect(signInCauseOf(reading("refused", "refresh_revoked"))).toBe("revoked");
    expect(signInCauseOf(reading("refused", "refresh_expired"))).toBe("expired");
    expect(signInCauseOf(reading("seal_failed", "seal_unreadable"))).toBe("seal");
    // The legacy code does not say which, so the ordinary sentence is said.
    expect(signInCauseOf(reading("refused", "unauthorized"))).toBeNull();
    expect(signInCauseOf(reading("renewing", "refresh_revoked"))).toBeNull();
    expect(signInCauseOf(null)).toBeNull();
  });

  it("a fault is due only after the grace; a live session never is", () => {
    const now = Date.now();
    const at = (ms: number): CloudSessionWire => ({ state: "unreachable", code: "network", since: new Date(now - ms).toISOString() });
    expect(cloudNoticeDue(at(CLOUD_NOTICE_GRACE_MS - 1), now)).toBe(false);
    expect(cloudNoticeDue(at(CLOUD_NOTICE_GRACE_MS), now)).toBe(true);
    expect(cloudNoticeDue({ state: "live", code: null, since: new Date(0).toISOString() }, now)).toBe(false);
    expect(cloudNoticeDue({ state: "seal_failed", code: "seal_write_failed", since: new Date(0).toISOString() }, now)).toBe(true);
    // An unreadable seal is the dialog's, never the rail's.
    expect(cloudNoticeDue({ state: "seal_failed", code: "seal_unreadable", since: new Date(0).toISOString() }, now)).toBe(false);
  });
});

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

const CLOUD_SERVING: EngineStatus = {
  state: "serving", mode: "cloud", address: "someone@ohmail.app", mailboxId: "mbx-1", credentialState: "ready",
};
/** A paired install in the engine-frame shape: `baseUrl` is the stdio address, the other computer `cloudUrl`. */
const PAIRED_SERVING: EngineStatus = {
  ...CLOUD_SERVING, flavor: "desktop-host", address: "someone@example.com",
  baseUrl: "http://sidecar", cloudUrl: "https://kestrel.tail1234.ts.net",
};

function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const EMPTY_PAGE = JSON.stringify({
  changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "MA", hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } });

/**
 * The stand-in shell: a cloud engine whose `/health` answers `health`. With `wait`, it holds
 * `/cloud/session/wait` as the engine does until `move()`; `reads` refuses the window's pulls
 * with that status (409 is the engine's `not_signed_in` after a refusal) and counts them.
 */
function fakeShell(health: Record<string, unknown>, opts: { wait?: boolean; reads?: number; status?: EngineStatus } = {}): {
  move(next: Record<string, unknown>): void;
  refusedReads(): number;
} {
  let next = 1;
  let current = health;
  let refused = 0;
  const held: Array<() => void> = [];
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => next++,
    invoke: async (command, payload) => {
      if (command === "engine_status") return opts.status ?? CLOUD_SERVING;
      if (command === "mailto_claim" || command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url === "/health") return encode(200, JSON.stringify(current));
        if (url.startsWith("/cloud/session/wait") && opts.wait) {
          // As the engine does: a reading that already differs from the one named is answered.
          const named = new URLSearchParams(url.split("?")[1] ?? "").get("state");
          const now = (current.session as CloudSessionWire | undefined)?.state ?? "none";
          if (named === now) await new Promise<void>((r) => held.push(r));
          return encode(200, JSON.stringify({ changed: true, session: current.session ?? null }));
        }
        if (opts.reads !== undefined && (url.startsWith("/sync") || url.startsWith("/mailboxes"))) {
          refused++;
          return encode(opts.reads, JSON.stringify({ error: { code: "not_signed_in", message: "not signed in" } }));
        }
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [] }));
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
  return {
    move: (n) => { current = n; for (const r of held.splice(0)) r(); },
    refusedReads: () => refused,
  };
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(h(IntlProvider, {
      locale: "en", messages: messages as never, timeZone: "UTC",
      children: h(ThemeProvider, { storageKey: "ohmail.theme", children: h(ToastHost, null, h(DesktopGate, null)) }),
    }));
  });
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return mountPoint;
}

const text = (el: HTMLElement): string => el.textContent ?? "";
const mounted = (el: HTMLElement): boolean => text(el).includes("Ohbox");
const dialog = (el: HTMLElement): boolean => text(el).includes(DOOR_COPY.cloudTitle);
/** The engine-down notice — never the answer to a refused Cloud session. */
const engineDown = (el: HTMLElement): boolean => text(el).includes(DOOR_COPY.gateCannotOpen);
const RETRYING = (messages as { sync: { failing: string } }).sync.failing;

/** Real time, in small turns, until `ok` holds or `ms` passes; answers how long it took. */
async function within(ms: number, ok: () => boolean): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 <= ms) {
    if (ok()) return Date.now() - t0;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  return ok() ? Date.now() - t0 : null;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  window.location.hash = "";
  localStorage.clear();
});
beforeEach(() => {
  window.location.hash = "";
  localStorage.clear();
});

describe("the gate over each session state", () => {
  it("renewing past the grace: the mail stays, no dialog, and the rail says Cloud is being retried", async () => {
    fakeShell({ signedIn: true, sessionExpired: false, session: reading("renewing", "http_403") });
    const el = await render();
    expect(mounted(el), "the mail app over a session that is only renewing").toBe(true);
    expect(dialog(el), "a firewall's 403 never opens the sign-in dialog").toBe(false);
    expect(text(el)).toContain(DOOR_COPY.cloudUnreachableTitle);
  });

  it("the positive control: inside the grace, and when live, the rail says nothing", async () => {
    fakeShell({ signedIn: true, sessionExpired: false, session: reading("unreachable", "network", 1_000) });
    const early = await render();
    expect(mounted(early)).toBe(true);
    expect(text(early)).not.toContain(DOOR_COPY.cloudUnreachableTitle);
    await act(async () => { root!.unmount(); });
    mountPoint?.remove();
    root = null;
    fakeShell({ signedIn: true, sessionExpired: false, session: reading("live", null) });
    const live = await render();
    expect(mounted(live)).toBe(true);
    expect(text(live)).not.toContain(DOOR_COPY.cloudUnreachableTitle);
  });

  it("a save the disk refused while signed in: the mail stays and the rail names the seal", async () => {
    fakeShell({ signedIn: true, sessionExpired: false, sealed: false, session: reading("seal_failed", "seal_write_failed") });
    const el = await render();
    expect(mounted(el)).toBe(true);
    expect(dialog(el)).toBe(false);
    expect(text(el)).toContain(DOOR_COPY.cloudSealPausedTitle(machineWord()));
  });

  for (const [code, lead] of [
    ["refresh_revoked", () => DOOR_COPY.cloudLeadRevoked(machineWord())],
    ["refresh_expired", () => DOOR_COPY.cloudLeadExpired(machineWord())],
    ["unauthorized", () => DOOR_COPY.cloudLeadSignIn(machineWord())],
  ] as const) {
    it(`a coded refusal (${code}) opens the dialog over the mail with the sentence for it`, async () => {
      fakeShell({ signedIn: false, sessionExpired: true, session: reading("refused", code) });
      const el = await render();
      expect(dialog(el), "the card is open without a press").toBe(true);
      expect(text(el)).toContain(lead());
      expect(mounted(el), "the mail stays behind the card").toBe(true);
      expect(engineDown(el), "a refused session is not the engine-down notice").toBe(false);
    });
  }

  it("a seal this key cannot open: the dialog at launch says so, not the first-run sentence", async () => {
    fakeShell({ signedIn: false, sessionExpired: false, session: reading("seal_failed", "seal_unreadable") });
    const el = await render();
    expect(dialog(el)).toBe(true);
    expect(text(el)).toContain(DOOR_COPY.cloudLeadSealFailed(machineWord()));
    expect(text(el)).not.toContain(DOOR_COPY.cloudLeadSignIn(machineWord()));
  });
});

/**
 * THE REFUSAL UNDER A WINDOW ALREADY SHOWING MAIL, as the packaged app met it: the engine knew
 * in three seconds, the window said "Retrying" and then emptied to the engine-down notice, and
 * the card never opened. The engine now answers the window's held question the moment
 * its reading moves; the card must be open inside two seconds of that, over the mail it kept.
 */
describe("a session refused while the mail is on screen", () => {
  it("opens the card within 2 s of the engine's refusal, names the cause, keeps the mail", async () => {
    const shell = fakeShell({ signedIn: true, sessionExpired: false, session: reading("live", null) }, { wait: true });
    const el = await render();
    expect(mounted(el)).toBe(true);
    expect(dialog(el)).toBe(false);

    shell.move({ signedIn: false, sessionExpired: true, session: reading("refused", "refresh_revoked", 0) });
    const took = await within(2_000, () => dialog(el));
    expect(took, "the card did not open within 2 s of the engine's refusal").not.toBeNull();
    expect(text(el)).toContain(DOOR_COPY.cloudLeadRevoked(machineWord()));
    expect(mounted(el), "the mail on screen was taken away").toBe(true);
    expect(engineDown(el)).toBe(false);
    expect(text(el)).not.toContain(RETRYING);
  });

  it("the positive control: with the session still live nothing opens, however long it is held", async () => {
    fakeShell({ signedIn: true, sessionExpired: false, session: reading("live", null) }, { wait: true });
    const el = await render();
    expect(await within(600, () => dialog(el))).toBeNull();
    expect(mounted(el)).toBe(true);
  });
});

/**
 * THE PAIRED DOOR'S TWIN: the other computer removed this one from its Devices list. The same
 * card over the kept mail, its sentence the unpaired one naming that computer, both remedies on
 * it; the pairing door opens over the list when pressed. Before, a GateNotice replaced the mail.
 */
describe("a paired install removed on the other computer", () => {
  const unpaired = (): string => DOOR_COPY.gateUnpaired(machineWord(), "kestrel");
  const buttons = (el: HTMLElement, label: string): HTMLButtonElement[] =>
    [...el.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(label));

  it("opens the card within 2 s of the engine's refusal, names the computer, keeps the mail", async () => {
    const shell = fakeShell({ signedIn: true, sessionExpired: false, session: reading("live", null) }, { wait: true, status: PAIRED_SERVING });
    const el = await render();
    expect(mounted(el)).toBe(true);
    expect(text(el)).not.toContain(unpaired());

    shell.move({ signedIn: false, sessionExpired: true, session: reading("refused", "refresh_revoked", 0) });
    const took = await within(2_000, () => text(el).includes(unpaired()));
    expect(took, "the unpaired card did not open within 2 s of the engine's refusal").not.toBeNull();
    expect(mounted(el), "the mail on screen was taken away").toBe(true);
    expect(engineDown(el), "a removed pairing is not the engine-down notice").toBe(false);
    expect(dialog(el), "the hosted password form is not this door's way back").toBe(false);
    expect(buttons(el, DOOR_COPY.gatePairAgain)).toHaveLength(1);
    expect(buttons(el, DOOR_COPY.gateOwn)).toHaveLength(1);
  });

  it("Pair again opens the pairing door over the kept mail, and the card steps aside", async () => {
    fakeShell({ signedIn: false, sessionExpired: true, session: reading("refused", "refresh_revoked") }, { status: PAIRED_SERVING });
    const el = await render();
    expect(text(el)).toContain(unpaired());
    await act(async () => { buttons(el, DOOR_COPY.gatePairAgain)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(await within(1_000, () => text(el).includes(DOOR_COPY.hostAskLead))).not.toBeNull();
    expect(text(el), "the card stays over the door it opened").not.toContain(unpaired());
    expect(mounted(el)).toBe(true);
  });

  it("the strip never says Retrying under the card, over at least three refused pulls", { timeout: 20_000 }, async () => {
    const shell = fakeShell({ signedIn: false, sessionExpired: true, session: reading("refused", "refresh_revoked") }, { reads: 409, status: PAIRED_SERVING });
    const el = await render();
    expect(text(el)).toContain(unpaired());
    expect(await within(5_000, () => text(el).includes(RETRYING)), "the strip said Retrying over a removed pairing").toBeNull();
    expect(shell.refusedReads()).toBeGreaterThanOrEqual(5);
  });

  it("a renewal fault on the paired door never borrows the Cloud sentence (the Cloud door's arm above says it)", async () => {
    fakeShell({ signedIn: true, sessionExpired: false, session: reading("renewing", "http_403") }, { status: PAIRED_SERVING });
    const el = await render();
    expect(mounted(el)).toBe(true);
    expect(text(el)).not.toContain(DOOR_COPY.cloudUnreachableTitle);
    expect(text(el)).not.toContain(unpaired());
  });

  it("the positive control: a live pairing opens nothing and keeps the mail", async () => {
    fakeShell({ signedIn: true, sessionExpired: false, session: reading("live", null) }, { wait: true, status: PAIRED_SERVING });
    const el = await render();
    expect(await within(600, () => text(el).includes(unpaired()))).toBeNull();
    expect(mounted(el)).toBe(true);
  });
});

/**
 * THE STRIP KEYS ON THE SESSION, NOT ON THE PULL. After a refusal every read the engine serves is
 * refused, so the window's pull fails on every attempt; its failure arm would say "Can't refresh.
 * Retrying." over a session nothing renews. The control drives the same failing reads under a live
 * session and watches the sentence arrive, so the fixture can say it.
 */
describe("the sync strip over a refused session", () => {
  it("never says Retrying while the card is up, over at least three refused pulls", { timeout: 20_000 }, async () => {
    const shell = fakeShell({ signedIn: false, sessionExpired: true, session: reading("refused", "refresh_revoked") }, { reads: 409 });
    const el = await render();
    expect(dialog(el)).toBe(true);
    // Watched for 5 s: the control below says it in about 2 s over the same refused pulls.
    expect(await within(5_000, () => text(el).includes(RETRYING)), "the strip said Retrying over a refused session").toBeNull();
    expect(shell.refusedReads(), "the window did not pull enough to fail three times").toBeGreaterThanOrEqual(5);
  });

  it("the positive control: the same refused pulls under a live session do say it", { timeout: 20_000 }, async () => {
    const shell = fakeShell({ signedIn: true, sessionExpired: false, session: reading("live", null) }, { reads: 409 });
    const el = await render();
    expect(await within(10_000, () => text(el).includes(RETRYING)), "the fixture never produced the sentence").not.toBeNull();
    expect(shell.refusedReads()).toBeGreaterThanOrEqual(3);
  });
});

/** ONE READING, THREE READERS: each answer keyed on the session state, and on nothing else. */
describe("the card, the rail and the strip read one session state", () => {
  const cases: Array<[string, CloudSessionWire | null, boolean]> = [
    ["live", reading("live", null), false],
    ["renewing", reading("renewing", "http_403"), false],
    ["unreachable", reading("unreachable", "network"), false],
    ["refused", reading("refused", "refresh_revoked"), true],
    ["seal_write_failed", reading("seal_failed", "seal_write_failed"), false],
    ["seal_unreadable", reading("seal_failed", "seal_unreadable"), false],
    ["none", null, false],
  ];
  for (const [name, session, expired] of cases) {
    it(`${name}: the card opens only for a refusal, the rail only for a session still there, the strip yields only to the card`, () => {
      const r = sessionReaders(session, expired, true);
      expect(r.card === "closed", "the card").toBe(!expired);
      if (expired) expect(r.card).toBe(signInCauseOf(session));
      const railSays = ["renewing", "unreachable", "seal_write_failed"].includes(name);
      expect(r.rail !== undefined, "the rail").toBe(railSays);
      expect(r.strip, "the strip").toBe(!expired);
    });
  }
  it("a refused reading silences the strip even before /health's verdict flag says so", () => {
    expect(sessionReaders(reading("refused", "refresh_revoked"), false, true).strip).toBe(false);
  });
});
