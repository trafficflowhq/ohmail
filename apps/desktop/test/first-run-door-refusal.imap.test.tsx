/** @vitest-environment jsdom */
/**
 * THE FIRST LAUNCH'S "ON THIS COMPUTER" DOOR SAYS ITS REFUSAL AND DOES NOT ENTER OVER IT. Over a
 * server with no encryption on the person's own network it asked no consent, the gate entered the
 * mail client at its next poll (the door was on disk), the rail said "Connected" over a mailbox with
 * no password, and every relaunch did it again. The whole window over the REAL engine, behind a
 * stand-in shell keeping the Rust shell's rules (a PENDING configure writes no door, `doorPending`),
 * dialling this checkout's GreenMail through a name the TLS floor does not exempt (`ip6-localhost`,
 * answered 127.0.0.1). No password, no LOGIN line and no address is printed.
 */
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import dns from "node:dns";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { messages as messageRows } from "@trafficflow/db";

import { DesktopGate, LIFECYCLE_POLL_MS } from "../src/DesktopGate.js";
import { DOOR_COPY } from "../src/door-copy.js";
import messages from "../../webapp/messages/en.json";
import { createSidecar, type Sidecar } from "../../sidecar/src/engine.js";
import { openLocalDb, PGDATA_SUBDIR } from "../../sidecar/src/db.js";

/* The name the TLS floor does not exempt, answered `address` by the operating system until the
 * returned restore runs: `dns.lookup` and `dns.promises.lookup` for that name, "no record" from the
 * Resolver queries. Kept in this file rather than imported, so the published file resolves alone. */
const HOME_NAME = "ip6-localhost";
function osAnswers(address: string): () => void {
  const lookup = dns.lookup;
  const promised = dns.promises.lookup;
  const r4 = dns.Resolver.prototype.resolve4;
  const r6 = dns.Resolver.prototype.resolve6;
  const family = address.includes(":") ? 6 : 4;
  dns.lookup = function stub(name: string, ...rest: unknown[]) {
    if (name !== HOME_NAME) return (lookup as (...a: unknown[]) => unknown).call(dns, name, ...rest);
    const cb = rest.find((a) => typeof a === "function") as (e: unknown, a?: unknown, f?: number) => void;
    const opts = (typeof rest[0] === "object" && rest[0] !== null ? rest[0] : {}) as { all?: boolean };
    queueMicrotask(() => (opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)));
  } as typeof dns.lookup;
  dns.promises.lookup = async function stub(name: string, ...rest: unknown[]) {
    if (name !== HOME_NAME) return (promised as (...a: unknown[]) => Promise<unknown>).call(dns.promises, name, ...rest);
    const opts = (rest[0] ?? {}) as { all?: boolean };
    return opts.all ? [{ address, family }] : { address, family };
  } as typeof dns.promises.lookup;
  const none = function (this: unknown, _h: string, cb: (e: unknown) => void) {
    queueMicrotask(() => cb(Object.assign(new Error("no record"), { code: dns.NOTFOUND })));
  };
  dns.Resolver.prototype.resolve4 = none as typeof r4;
  dns.Resolver.prototype.resolve6 = none as typeof r6;
  return () => {
    dns.lookup = lookup;
    dns.promises.lookup = promised;
    dns.Resolver.prototype.resolve4 = r4;
    dns.Resolver.prototype.resolve6 = r6;
  };
}

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

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

const GM = "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3025);
function imapAnswers(hostName: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: boolean): void => { if (settled) return; settled = true; sock.destroy(); resolve(v); };
    const sock = netConnect({ host: hostName, port });
    sock.setTimeout(timeoutMs);
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.on("data", (b: Buffer) => finish(/^\* (OK|PREAUTH)/im.test(b.toString("utf8"))));
    sock.once("close", () => finish(false));
  });
}
const SERVER_UP = await imapAnswers(GM, IMAP_PORT);

function encode(res: { status: number; statusText: string; headers: Headers }, body: Uint8Array): Uint8Array {
  const pairs: [string, string][] = [];
  res.headers.forEach((v, k) => pairs.push([k, v]));
  const meta = new TextEncoder().encode(JSON.stringify({ status: res.status, statusText: res.statusText, h: pairs }));
  const out = new Uint8Array(4 + meta.byteLength + body.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(body, 4 + meta.byteLength);
  return out;
}

let template: Promise<string> | null = null;
afterAll(async () => {
  const built = await template?.catch(() => null);
  if (built) rmSync(built, { recursive: true, force: true });
});
async function freshDataDir(tag: string): Promise<string> {
  template ??= (async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-probe-fd-template-"));
    await (await openLocalDb(dir)).close();
    return dir;
  })();
  const built = await template;
  const dir = mkdtempSync(join(realpathSync(tmpdir()), tag));
  cpSync(join(built, PGDATA_SUBDIR), join(dir, PGDATA_SUBDIR), { recursive: true });
  return dir;
}

/** The shell's rules over one real local engine: the configure replaces it, the door persists. */
function standInShell(dataDir: string) {
  const keks = { 1: randomBytes(32) };
  let engine: Sidecar | null = null;
  let starting: Promise<void> | null = null;
  let door: Record<string, unknown> | null = null;
  const configured: Record<string, unknown>[] = [];
  const events: string[] = [];
  const seals: Array<{ imap: boolean; smtp: boolean }> = [];
  /** When a seal was first answered 200 — the moment "Connected" becomes true of this mailbox. */
  let sealedAt: number | null = null;
  let asked = 0;
  /** The door on disk, and the settings a PENDING engine runs from without writing one. */
  let pending: Record<string, unknown> | null = null;
  const status = async (): Promise<Record<string, unknown>> => {
    const flag = pending ? { doorPending: true } : {};
    if (engine) {
      return {
        state: "serving", mode: door ? "local" : null, ...(door ? { address: door.address } : {}),
        mailboxId: engine.world.mailboxId, credentialState: await engine.credentialState(), ...flag,
      };
    }
    if (starting || door || pending) return { state: "starting", mode: door ? "local" : null, ...flag };
    return { state: "not_configured", mode: null, missing: ["config.json"] };
  };
  const launch = (config: Record<string, unknown>): void => {
    const imap = config.imap as { host: string; port: number; secure: boolean; user: string };
    const smtp = config.smtp as { host: string; port: number; secure: boolean } | undefined;
    const leaving = engine;
    engine = null;
    starting = (async () => {
      await leaving?.stop();
      const next = await createSidecar({
        dataDir, address: String(config.address), keks,
        imap: {
          host: imap.host, port: imap.port, secure: imap.secure, auth: { user: imap.user },
          ...(smtp ? { smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure } } : {}),
        },
        machineName: "the computer being set up",
        pollIntervalMs: 15_000,
        leaseStaleAfterMs: 60_000,
        log: (event: string) => { events.push(event); },
      } as Parameters<typeof createSidecar>[0]);
      engine = next;
      starting = null;
      void next.start().catch(() => undefined);
    })();
  };
  let nextId = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => nextId++,
    invoke: async (command, payload) => {
      if (command === "engine_status") { asked += 1; return status(); }
      if (command === "engine_configure") {
        const config = payload!.config as Record<string, unknown>;
        configured.push(config);
        if (config.pending === true) {
          // The shell's rule: refused over a written door, and nothing is written.
          if (door) throw new Error("this install already has a door");
          pending = config;
        } else {
          door = config;
          pending = null;
        }
        launch(config);
        return status();
      }
      if (command === "engine_logout") {
        await starting?.catch(() => undefined);
        await engine?.stop().catch(() => undefined);
        engine = null;
        door = null;
        pending = null;
        return status();
      }
      if (command === "engine_request") {
        if (!engine) throw new Error("the engine is not serving");
        const bytes = new Uint8Array((payload!.body as number[]) ?? []);
        const method = String(payload!.method);
        /* WHICH LINES A SEAL CARRIED — booleans only; the body carries the password. */
        if (method === "PATCH" && String(payload!.url).startsWith("/local/mailboxes/")) {
          const sent = JSON.parse(new TextDecoder().decode(bytes)) as { imap?: { allowInsecure?: unknown }; smtp?: { allowInsecure?: unknown } };
          seals.push({ imap: sent.imap?.allowInsecure === true, smtp: sent.smtp?.allowInsecure === true });
        }
        const res = await engine.handle(new Request(`http://sidecar${String(payload!.url)}`, {
          method,
          headers: [...(payload!.headers as [string, string][]), ["authorization", `Bearer ${engine.sessionToken}`]],
          ...(method === "GET" || method === "HEAD" ? {} : { body: bytes }),
        }));
        if (method === "PATCH" && String(payload!.url).startsWith("/local/mailboxes/") && res.status === 200) {
          sealedAt ??= Date.now();
        }
        return encode(res, new Uint8Array(await res.arrayBuffer()));
      }
      if (command === "plugin:event|listen") return nextId++;
      return null;
    },
  };
  return {
    configured, events, seals, asked: (): number => asked, door: () => door, sealedAt: () => sealedAt,
    /** A quit and relaunch: the engine goes, a pending door with it, and the door on disk stays. */
    async relaunch(): Promise<void> {
      await starting?.catch(() => undefined);
      await engine?.stop().catch(() => undefined);
      engine = null;
      pending = null;
      if (door) launch(door);
    },
    credentialState: async (): Promise<string | null> => (engine ? engine.credentialState() : null),
    stored: async (): Promise<number> => (engine
      ? (await engine.db.select({ id: messageRows.id }).from(messageRows).where(eq(messageRows.mailboxId, engine.world.mailboxId))).length
      : 0),
    async stop(): Promise<void> {
      await starting?.catch(() => undefined);
      await engine?.stop().catch(() => undefined);
    },
  };
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;
const dirs: string[] = [];
let shell: ReturnType<typeof standInShell> | null = null;
let restoreDns: (() => void) | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  mountPoint?.remove();
  mountPoint = null;
  await shell?.stop();
  shell = null;
  restoreDns?.();
  restoreDns = null;
  delete host.__TAURI_INTERNALS__;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
  return mountPoint;
}
async function remount(): Promise<HTMLElement> {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  return render();
}

const tick = async (ms = 25): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
/** Real time in small acts, so every render between is flushed and seen. */
const pass_ = async (ms: number): Promise<void> => { const end = Date.now() + ms; while (Date.now() < end) await tick(50); };
async function until(el: HTMLElement, what: string, test: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (test()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}; the window said: ${el.textContent?.slice(0, 400)}`);
}
function press(el: HTMLElement, label: string): Promise<void> {
  const found = [...el.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === label);
  if (found.length !== 1) throw new Error(`expected one button saying "${label}", found ${found.length}`);
  return act(async () => { found[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
async function type(el: HTMLElement, id: string, value: string): Promise<void> {
  const input = el.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no field #${id} on screen`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const text = (el: HTMLElement): string => el.textContent ?? "";
const onCard = (el: HTMLElement): boolean => text(el).includes(DOOR_COPY.localTitle) && [...el.querySelectorAll("button")]
  .some((b) => [DOOR_COPY.localOpen, DOOR_COPY.localOpening].includes((b.textContent ?? "").trim()));
const mailMounted = (el: HTMLElement): boolean => text(el).includes("Ohbox") && el.querySelector(".gate-boot") === null;
const CONSENT = (messages as unknown as { mailboxes: { insecureConsentLabel: string } }).mailboxes.insecureConsentLabel;
const consentShown = (el: HTMLElement): boolean => [...el.querySelectorAll("label")]
  .some((l) => (l.textContent ?? "").includes(CONSENT) && l.querySelector("input[type=checkbox]") !== null);
const STRIP_CONNECTED = "Connected. The first sync";
const shape = (el: HTMLElement): string => (mailMounted(el) ? "mail" : el.querySelector(".gate-boot") ? "boot" : onCard(el) ? "card" : "other");

async function seedServer(address: string, pass: string): Promise<void> {
  const seeder = new ImapFlow({ host: GM, port: IMAP_PORT, secure: false, auth: { user: address, pass }, logger: false });
  await seeder.connect();
  try {
    await seeder.append("INBOX", Buffer.from([
      "From: sender <sender@example.test>", `To: <${address}>`, "Subject: first door",
      `Message-ID: <first-door-${randomUUID()}@example.test>`,
      "Date: Mon, 28 Sep 2026 10:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "body", "",
    ].join("\r\n"), "utf8"));
  } finally {
    await seeder.logout().catch(() => undefined);
  }
}

/** The first launch's "On this computer" door, the generic entry, typed by hand. */
async function walkTheDoor(el: HTMLElement, address: string, pass: string, serverName: string): Promise<void> {
  await until(el, "the first-run chooser", () => text(el).includes(DOOR_COPY.chooserTitle), 30_000);
  const tile = [...el.querySelectorAll(".door-tile")].find((b) => (b.querySelector(".door-name")?.textContent ?? "").startsWith("On this "));
  if (!tile) throw new Error("no On this computer tile");
  await act(async () => { tile.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await until(el, "the local card", () => text(el).includes(DOOR_COPY.localTitle), 10_000);
  const generic = [...el.querySelectorAll("button")].filter((b) => (b.textContent ?? "").startsWith("Any other IMAP mailbox"));
  if (generic.length !== 1) throw new Error(`expected one generic provider, found ${generic.length}`);
  await act(async () => { generic[0]!.click(); });
  await type(el, "door-address", address);
  await type(el, "door-password", pass);
  await type(el, "door-imap-host", serverName);
  await type(el, "door-imap-port", String(IMAP_PORT));
  await type(el, "door-smtp-host", serverName);
  await type(el, "door-smtp-port", String(SMTP_PORT));
}


/** Every rendered frame, read on each DOM change: the shape, and whether a sentence ever showed. */
function watchWindow(el: HTMLElement) {
  const t0 = Date.now();
  const shown: string[] = [];
  const seen = { consent: false, connectedAt: null as number | null, refusal: false };
  const read = (): void => {
    const now = shape(el);
    if (shown[shown.length - 1]?.endsWith(now) !== true) shown.push(`${Date.now() - t0}ms ${now}`);
    seen.consent ||= consentShown(el);
    if (seen.connectedAt === null && text(el).includes(STRIP_CONNECTED)) seen.connectedAt = Date.now();
    seen.refusal ||= text(el).includes("offers no encryption");
  };
  const watch = new MutationObserver(read);
  watch.observe(el, { childList: true, subtree: true, characterData: true });
  return { shown, seen, stop: () => { read(); watch.disconnect(); } };
}

async function tickLine(el: HTMLElement, label: string): Promise<void> {
  const box = [...el.querySelectorAll("label")].find((l) => (l.textContent ?? "").includes(label))
    ?.querySelector<HTMLInputElement>("input[type=checkbox]");
  if (!box) throw new Error(`no line "${label}" on screen`);
  await act(async () => { box.click(); });
}

describe.skipIf(!SERVER_UP)("the first launch's local door over a server that offers no encryption", () => {
  it("says the refusal, offers the Add form's line, does not enter, and a relaunch is the chooser", async () => {
    restoreDns = osAnswers("127.0.0.1");
    const address = `fd-${randomUUID()}@trafficflow.test`;
    const pass = randomUUID();
    await seedServer(address, pass);
    const dataDir = await freshDataDir("ohmail-first-door-refused-");
    dirs.push(dataDir);
    shell = standInShell(dataDir);
    const el = await render();
    await walkTheDoor(el, address, pass, HOME_NAME);
    const window = watchWindow(el);
    await press(el, DOOR_COPY.localOpen);
    await until(el, "the refusal and its line", () => consentShown(el) && text(el).includes("offers no encryption"), 30_000);
    // Two of the gate's lifecycle polls: the one that entered the mail client over the refusal.
    await pass_(2 * LIFECYCLE_POLL_MS + 1_000);
    window.stop();
    expect(window.shown.some((s) => s.endsWith("mail")), `the door entered: ${window.shown.join(", ")}`).toBe(false);
    expect(window.seen.connectedAt, "the rail said Connected over a mailbox with no password").toBeNull();
    expect(shell.door(), "the refused first door was written").toBeNull();
    expect(shell.configured.map((c) => c.pending === true), "the first configure was not pending").toEqual([true]);
    expect(await shell.credentialState()).toBe("absent");

    // The next launch reads what the shell holds: no door, so the chooser.
    await shell.relaunch();
    const again = await remount();
    await until(again, "the chooser after a relaunch", () => text(again).includes(DOOR_COPY.chooserTitle), 30_000);
    expect(mailMounted(again)).toBe(false);
  }, 180_000);

  it("a press with the line shown and not ticked carries no consent: the refusal and the line again, no door", async () => {
    restoreDns = osAnswers("127.0.0.1");
    const address = `fd-${randomUUID()}@trafficflow.test`;
    const pass = randomUUID();
    await seedServer(address, pass);
    const dataDir = await freshDataDir("ohmail-first-door-unticked-");
    dirs.push(dataDir);
    shell = standInShell(dataDir);
    const el = await render();
    await walkTheDoor(el, address, pass, HOME_NAME);
    const window = watchWindow(el);
    await press(el, DOOR_COPY.localOpen);
    await until(el, "the refusal and its line", () => consentShown(el) && text(el).includes("offers no encryption"), 30_000);
    await press(el, DOOR_COPY.localOpen);
    const idle = (): boolean => [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim() === DOOR_COPY.localOpen);
    await until(el, "the second press to settle", () => shell!.seals.length >= 2 && (mailMounted(el) || shell!.door() !== null
      || (idle() && consentShown(el) && text(el).includes("offers no encryption"))), 30_000);
    await pass_(2 * LIFECYCLE_POLL_MS + 1_000);
    window.stop();
    expect(shell.seals.map((s) => s.imap), "the unticked press carried the consent").toEqual([false, false]);
    expect(shell.seals.map((s) => s.smtp)).toEqual([false, false]);
    expect(shell.door(), "a door was written without the tick").toBeNull();
    expect(shell.configured.map((c) => c.pending === true), "a commit followed the unticked press").toEqual([true, true]);
    expect(window.shown.some((s) => s.endsWith("mail")), `the door entered: ${window.shown.join(", ")}`).toBe(false);
    expect(consentShown(el) && text(el).includes("offers no encryption"), "the refusal and its line are gone").toBe(true);
    expect(await shell.credentialState()).toBe("absent");
  }, 180_000);

  it("with the line ticked it seals, writes the door, enters and syncs", async () => {
    restoreDns = osAnswers("127.0.0.1");
    const address = `fd-${randomUUID()}@trafficflow.test`;
    const pass = randomUUID();
    await seedServer(address, pass);
    const dataDir = await freshDataDir("ohmail-first-door-consented-");
    dirs.push(dataDir);
    shell = standInShell(dataDir);
    const el = await render();
    await walkTheDoor(el, address, pass, HOME_NAME);
    const window = watchWindow(el);
    await press(el, DOOR_COPY.localOpen);
    await until(el, "the line", () => consentShown(el), 30_000);
    await tickLine(el, CONSENT);
    await press(el, DOOR_COPY.localOpen);
    await until(el, "the mail after the consented seal", () => mailMounted(el), 60_000);
    await vi.waitFor(async () => { expect(await shell!.stored()).toBe(1); }, { timeout: 20_000, interval: 200 });
    window.stop();
    expect(shell.seals.map((s) => s.imap), "only the ticked press carried the consent").toEqual([false, true]);
    expect(shell.door(), "the door was not written by its commit").not.toBeNull();
    expect(shell.configured.map((c) => c.pending === true)).toEqual([true, true, false]);
    expect(await shell.credentialState()).toBe("ready");
    const sealedAt = shell.sealedAt();
    expect(sealedAt, "no seal was answered").not.toBeNull();
    expect(window.seen.connectedAt === null || window.seen.connectedAt >= sealedAt!,
      "the rail said Connected before the password was sealed").toBe(true);
  }, 180_000);

  it("a change to the server retires the line and its tick", async () => {
    restoreDns = osAnswers("127.0.0.1");
    const address = `fd-${randomUUID()}@trafficflow.test`;
    const pass = randomUUID();
    await seedServer(address, pass);
    const dataDir = await freshDataDir("ohmail-first-door-retired-");
    dirs.push(dataDir);
    shell = standInShell(dataDir);
    const el = await render();
    await walkTheDoor(el, address, pass, HOME_NAME);
    await press(el, DOOR_COPY.localOpen);
    await until(el, "the line", () => consentShown(el), 30_000);
    await tickLine(el, CONSENT);
    await type(el, "door-imap-port", String(IMAP_PORT + 1));
    expect(consentShown(el), "a consent outlived the server it was offered for").toBe(false);
    await type(el, "door-imap-port", String(IMAP_PORT));
    await press(el, DOOR_COPY.localOpen);
    await until(el, "the line offered again", () => consentShown(el), 30_000);
    expect(shell.seals.map((s) => s.imap), "the retired tick was sent").toEqual([false, false]);
  }, 180_000);

  it("CONTROL: the same door over the loopback literal (exempt from the floor) seals and enters", async () => {
    const address = `fd-${randomUUID()}@trafficflow.test`;
    const pass = randomUUID();
    await seedServer(address, pass);
    const dataDir = await freshDataDir("ohmail-first-door-loopback-");
    dirs.push(dataDir);
    shell = standInShell(dataDir);
    const el = await render();
    await walkTheDoor(el, address, pass, GM);
    await press(el, DOOR_COPY.localOpen);
    await until(el, "the mail after a sealed door", () => mailMounted(el), 60_000);
    expect(await shell.credentialState()).toBe("ready");
  }, 180_000);
});
