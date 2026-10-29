/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    // A reuse sweep's cause is kept; any other value is not a cause.
    const since = "2026-10-28T18:32:49.000Z";
    expect(sessionOf({ state: "refused", code: "refresh_revoked", since, cause: "reuse" }))
      .toEqual({ state: "refused", code: "refresh_revoked", since, cause: "reuse" });
    expect(sessionOf({ state: "refused", code: "refresh_revoked", since, cause: "copied" }))
      .toEqual({ state: "refused", code: "refresh_revoked", since });
  });

  it("names a reuse sweep apart from a plain revocation, now and at the next launch", () => {
    expect(signInCauseOf({ ...reading("refused", "refresh_revoked"), cause: "reuse" })).toBe("reused");
    expect(signInCauseOf({ ...reading("refused_before", "refresh_revoked"), cause: "reuse" })).toBe("reused");
    expect(signInCauseOf({ ...reading("renewing", "refresh_revoked"), cause: "reuse" })).toBeNull();
  });

  it("names a cause only for the two refusals and the unreadable seal", () => {
    expect(signInCauseOf(reading("refused", "refresh_revoked"))).toBe("revoked");
    expect(signInCauseOf(reading("refused", "refresh_expired"))).toBe("expired");
    expect(signInCauseOf(reading("seal_failed", "seal_unreadable"))).toBe("seal");
    // A refusal an earlier run heard names the same cause at the next launch.
    expect(signInCauseOf(reading("refused_before", "refresh_revoked"))).toBe("revoked");
    expect(signInCauseOf(reading("refused_before", "refresh_expired"))).toBe("expired");
    // The legacy code does not say which, so the ordinary sentence is said.
    expect(signInCauseOf(reading("refused", "unauthorized"))).toBeNull();
    expect(signInCauseOf(reading("refused_before", "unauthorized"))).toBeNull();
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
function fakeShell(health: Record<string, unknown>, opts: {
  wait?: boolean; reads?: number; status?: EngineStatus;
  /** The hosted `GET /auth/session` answer, relayed on the account door; absent answers no account. */
  hosted?: Record<string, unknown>;
} = {}): {
  move(next: Record<string, unknown>): void;
  refusedReads(): number;
  /** Every `POST /auth/reuse-sweeps/ack` body the window sent over the bridge. */
  acks(): unknown[];
} {
  let next = 1;
  let current = health;
  let refused = 0;
  const acks: unknown[] = [];
  const held: Array<() => void> = [];
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => next++,
    invoke: async (command, payload) => {
      if (command === "engine_status") return opts.status ?? CLOUD_SERVING;
      if (command === "mailto_claim" || command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url === "/health") return encode(200, JSON.stringify(current));
        if (url === "/auth/session" && opts.hosted) return encode(200, JSON.stringify(opts.hosted));
        if (url === "/auth/reuse-sweeps/ack" && payload?.method === "POST") {
          acks.push(JSON.parse(new TextDecoder().decode(new Uint8Array(payload.body as number[]))));
          return encode(204, "");
        }
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
    acks: () => acks,
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
/**
 * THE CARD HOLDS THE KEYBOARD: focus stands inside `card` (the in-session dialog, or the whole
 * page at launch), and no Tab stop outside it is reachable (outside an `[inert]` subtree). The
 * in-session dialog also claims the page and is described by `cause`, so a reader says why.
 */
function holdsFocus(card: Element | null, cause: string, where: string): void {
  expect(card, `${where}: no card`).not.toBeNull();
  expect(card!.contains(document.activeElement), `${where}: focus is on ${document.activeElement?.tagName}`).toBe(true);
  const outside = [...document.body.querySelectorAll<HTMLElement>("*")].filter((n) =>
    n.tabIndex >= 0 && !(n as HTMLButtonElement).disabled && !card!.contains(n) && n.closest("[inert]") === null);
  expect(outside.map((n) => n.outerHTML.slice(0, 60)), `${where}: Tab reaches the mail behind the card`).toEqual([]);
  if (!card!.matches(".session-end")) return;
  expect(card!.getAttribute("aria-modal")).toBe("true");
  const said = (card!.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
  expect(said, `${where}: the dialog's description`).toContain(cause);
}
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

  it("a reuse sweep's refusal: the dialog says what happened and what to do, not the plain revocation", async () => {
    fakeShell({ signedIn: false, sessionExpired: true, session: { ...reading("refused", "refresh_revoked"), cause: "reuse" } });
    const el = await render();
    expect(dialog(el)).toBe(true);
    expect(text(el)).toContain(DOOR_COPY.cloudLeadReused(machineWord()));
    expect(text(el)).not.toContain(DOOR_COPY.cloudLeadRevoked(machineWord()));
  });

  it("a seal this key cannot open: the dialog at launch says so, not the first-run sentence", async () => {
    fakeShell({ signedIn: false, sessionExpired: false, session: reading("seal_failed", "seal_unreadable") });
    const el = await render();
    expect(dialog(el)).toBe(true);
    expect(text(el)).toContain(DOOR_COPY.cloudLeadSealFailed(machineWord()));
    expect(text(el)).not.toContain(DOOR_COPY.cloudLeadSignIn(machineWord()));
  });

  it("a refusal an earlier run heard: the dialog at launch names it, not the first-run sentence", async () => {
    fakeShell({ signedIn: false, sessionExpired: false, session: reading("refused_before", "refresh_revoked") });
    const el = await render();
    expect(dialog(el)).toBe(true);
    expect(text(el)).toContain(DOOR_COPY.cloudLeadRevoked(machineWord()));
    expect(text(el)).not.toContain(DOOR_COPY.cloudLeadSignIn(machineWord()));
    holdsFocus(el, DOOR_COPY.cloudLeadRevoked(machineWord()), "relaunch");
  });
});

/* A door to the person's own server signs in to that server: the address it proved stays, and
   neither ohmail Cloud nor a copy of mail a fresh install does not have is named. */
describe("the sign-in over a door to the person's own server", () => {
  const SELF_HOSTED: EngineStatus = {
    ...CLOUD_SERVING, address: "someone@mail.example.org", cloudUrl: "https://mail.example.org",
  };
  const reached = () => DOOR_COPY.serverReached("https://mail.example.org", "someone@mail.example.org");

  it("after the address step: the server's own sign-in, its address kept, no Cloud and no copy", async () => {
    fakeShell({ signedIn: false, sessionExpired: false }, { status: SELF_HOSTED });
    const el = await render();
    expect(text(el)).toContain(DOOR_COPY.doorServerName);
    expect(text(el)).toContain(reached());
    expect(dialog(el), "a self-hoster was asked to sign in to ohmail Cloud").toBe(false);
    expect(text(el)).not.toContain("The copy of your mail");
    expect(el.querySelector("#server-password"), "no password field for the server").toBeTruthy();
  });

  it("a refused session there says why, over the mail, on the server's own card", async () => {
    fakeShell({ signedIn: false, sessionExpired: true, session: reading("refused", "refresh_revoked") }, { status: SELF_HOSTED });
    const el = await render();
    expect(dialog(el)).toBe(false);
    expect(text(el)).toContain(DOOR_COPY.cloudLeadRevoked(machineWord()));
    expect(text(el)).toContain(reached());
    expect(mounted(el), "the mail stays behind the card").toBe(true);
  });

  it("control: the managed door keeps the Cloud sign-in", async () => {
    fakeShell({ signedIn: false, sessionExpired: false });
    const el = await render();
    expect(dialog(el)).toBe(true);
    expect(el.querySelector("#server-password")).toBeNull();
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
    holdsFocus(el.querySelector(".session-end"), DOOR_COPY.cloudLeadRevoked(machineWord()), "in-session");
  });

  it("gives focus back to where it stood once the session is live again and the card closes", async () => {
    const shell = fakeShell({ signedIn: true, sessionExpired: false, session: reading("live", null) }, { wait: true });
    const el = await render();
    const stood = el.querySelector<HTMLElement>(".shell button")!;
    stood.focus();
    shell.move({ signedIn: false, sessionExpired: true, session: reading("refused", "refresh_revoked", 0) });
    expect(await within(2_000, () => dialog(el))).not.toBeNull();
    expect(el.querySelector(".session-end")!.contains(document.activeElement)).toBe(true);
    shell.move({ signedIn: true, sessionExpired: false, session: reading("live", null) });
    expect(await within(2_000, () => el.querySelector(".session-end") === null)).not.toBeNull();
    expect([...el.querySelectorAll(".app-root, .app-root ~ *")].filter((n) => n.hasAttribute("inert")), "the mail stayed inert").toEqual([]);
    expect(document.activeElement).toBe(stood);
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
    holdsFocus(el.querySelector(".session-end"), unpaired(), "paired, in-session");
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

/**
 * THE SIGN-IN THAT FOLLOWS A SWEEP IS TOLD OF IT. The account door's one hosted session read
 * carries the sweeps; the strip says them once over the mail, and OK puts them away on the server
 * over the bridge. Nothing listed, nothing drawn.
 */
describe("the reuse sweeps a new sign-in is told of", () => {
  const SWEEP = { id: "5d0c6f6e-2a39-4b49-9b8e-1d6b0b8f7a01", at: "2026-10-28T18:32:49.000Z", client: "desktop-linux" };
  const hosted = (sweeps?: unknown[]): Record<string, unknown> =>
    ({ scope: "full", user: { accountId: "acct-hosted-7" }, ...(sweeps ? { reuseSweeps: sweeps } : {}) });
  const S = (messages as { settings: Record<string, string> }).settings;
  const okButton = (el: HTMLElement): HTMLButtonElement | undefined =>
    [...el.querySelectorAll("button")].find((b) => b.textContent === S.reuseSweepsOk);

  it("is shown once, acknowledged over the bridge with its id, and goes", async () => {
    const shell = fakeShell({ signedIn: true, sessionExpired: false, session: reading("live", null) }, { hosted: hosted([SWEEP]) });
    const el = await render();
    const details = () => [...el.querySelectorAll("button")].find((b) => b.textContent === S.reuseSweepsDetails);
    expect(await within(2_000, () => details() !== undefined), "the strip never came").not.toBeNull();
    await act(async () => { details()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(text(el).split(S.reuseClientLinux!).length - 1, "said once").toBe(1);
    await act(async () => { okButton(el)!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(await within(1_000, () => shell.acks().length > 0)).not.toBeNull();
    expect(shell.acks()).toEqual([{ ids: [SWEEP.id] }]);
    expect(text(el)).not.toContain(S.reuseClientLinux);
    expect(mounted(el)).toBe(true);
  });

  it("OK in a browser takes it away in this window at its next return: the session read lists none", async () => {
    const answer = hosted([SWEEP]);
    const shell = fakeShell({ signedIn: true, sessionExpired: false, session: reading("live", null) }, { hosted: answer });
    const el = await render();
    expect(await within(2_000, () => okButton(el) !== undefined), "the strip never came").not.toBeNull();
    delete answer.reuseSweeps;
    // Past the return debounce, then back to the window.
    await act(async () => { await new Promise((r) => setTimeout(r, 1_600)); });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(await within(2_000, () => okButton(el) === undefined), "the notice outlived the read").not.toBeNull();
    expect(shell.acks(), "this window acknowledged nothing").toEqual([]);
    expect(mounted(el)).toBe(true);
  });

  it("the control: nothing listed, nothing drawn", async () => {
    fakeShell({ signedIn: true, sessionExpired: false, session: reading("live", null) }, { hosted: hosted() });
    const el = await render();
    expect(mounted(el)).toBe(true);
    expect(okButton(el)).toBeUndefined();
  });
});

/**
 * THE CARD FITS THE WINDOW, IN-SESSION AS AFTER A RELAUNCH. The in-session card was drawn ~75px
 * wide (`.join-card` is an inline-size container and its `.gate` shrank to fit it), the buttons a
 * thousand pixels below a 900px window; and over a window that had read no mail it stood over an
 * empty list while saying the copy is where you left it. The gate's markup, laid out in Chromium
 * under the window's stylesheets: the same card both ways, whole, and over mail only when there is mail.
 */
describe("the refused card in the window", () => {
  const SHEETS = [
    "packages/tokens/src/tokens.css", "packages/tokens/src/faces.css", "packages/tokens/src/ohmarchy.css",
    "packages/ui/src/base.css", "packages/ui/src/primitives/button.css", "packages/ui/src/primitives/text-field.css",
    "packages/ui/src/primitives/toast.css", "packages/ui/src/primitives/spinner.css",
    "apps/webapp/app/app.css", "apps/webapp/app/zero-layout.css",
  ].map((p) => readFileSync(resolve(process.cwd(), p), "utf8")).join("\n");
  const WINDOWS = [[1440, 900], [1024, 768]] as const;
  type Reading = { card: { x: number; y: number; width: number; height: number }; button: { y: number; height: number }; alpha: number };
  let browser: Awaited<ReturnType<typeof import("@playwright/test")["chromium"]["launch"]>> | null = null;

  beforeAll(async () => {
    const { chromium } = createRequire(resolve(process.cwd(), "package.json"))("@playwright/test") as typeof import("@playwright/test");
    browser = await chromium.launch();
  }, 120_000);
  afterAll(async () => { await browser?.close(); });

  /** The window's markup at `width`×`height`: the card's box, its Sign in button, the layer's opacity. */
  async function measure(html: string, width: number, height: number): Promise<Reading> {
    const page = await browser!.newPage({ viewport: { width, height } });
    try {
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${SHEETS}</style>
        <style>*{animation:none!important}</style></head><body class="mo-canvas app-body"><div id="root">${html}</div></body></html>`);
      const card = page.locator(".gate-card").last();
      const layer = await page.evaluate(() => {
        const at = document.querySelector(".session-end");
        return at ? getComputedStyle(at).backgroundColor : "none";
      });
      const alpha = /\/\s*([\d.]+)\)$/.exec(layer)?.[1] ?? /rgba\([^)]*,\s*([\d.]+)\)$/.exec(layer)?.[1];
      return {
        card: (await card.boundingBox())!,
        button: (await card.getByRole("button", { name: "Sign in", exact: true }).boundingBox())!,
        alpha: alpha === undefined ? 1 : Number(alpha),
      };
    } finally {
      await page.close();
    }
  }
  const reused = () => ({ ...reading("refused", "refresh_revoked", 0), cause: "reuse" });
  function fits(r: Reading, width: number, height: number, where: string): void {
    expect(r.card.width, `${where}: the card is ${r.card.width}px wide`).toBeGreaterThanOrEqual(400);
    expect(r.card.x, where).toBeGreaterThanOrEqual(0);
    expect(r.card.x + r.card.width, where).toBeLessThanOrEqual(width);
    expect(Math.abs(r.card.x + r.card.width / 2 - width / 2), `${where}: off centre`).toBeLessThanOrEqual(8);
    expect(r.button.y + r.button.height, `${where}: Sign in below the window`).toBeLessThanOrEqual(height);
  }

  it("after a relaunch, the card the in-session one is held to", { timeout: 60_000 }, async () => {
    fakeShell({ signedIn: false, sessionExpired: false, session: { ...reused(), state: "refused_before" } });
    const el = await render();
    expect(text(el)).toContain(DOOR_COPY.cloudLeadReused(machineWord()));
    for (const [w, hgt] of WINDOWS) fits(await measure(el.innerHTML, w, hgt), w, hgt, `relaunch ${w}x${hgt}`);
  });

  it("refused before the window read any mail: the same card, whole, on the window's own page", { timeout: 60_000 }, async () => {
    fakeShell({ signedIn: false, sessionExpired: true, session: reused() }, { reads: 409 });
    const el = await render();
    expect(dialog(el)).toBe(true);
    expect(text(el)).toContain(DOOR_COPY.cloudLeadReused(machineWord()));
    for (const [w, hgt] of WINDOWS) {
      const r = await measure(el.innerHTML, w, hgt);
      fits(r, w, hgt, `in-session ${w}x${hgt}`);
      expect(r.alpha, "an empty list showed through behind 'the copy of your mail here is where you left it'").toBe(1);
    }
  });

  it("refused over mail this launch read: the same card, whole, the mail kept in view", { timeout: 60_000 }, async () => {
    const shell = fakeShell({ signedIn: true, sessionExpired: false, session: reading("live", null) }, { wait: true });
    const el = await render();
    await within(500, () => false);
    shell.move({ signedIn: false, sessionExpired: true, session: reused() });
    expect(await within(2_000, () => dialog(el))).not.toBeNull();
    expect(mounted(el)).toBe(true);
    for (const [w, hgt] of WINDOWS) {
      const r = await measure(el.innerHTML, w, hgt);
      fits(r, w, hgt, `over mail ${w}x${hgt}`);
      expect(r.alpha, "the scrim hid the mail it is there to keep").toBeLessThan(1);
    }
  });
});
