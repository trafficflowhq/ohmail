/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "use-intl";
import { DOORS, plantShell, type Pipe } from "./_doors-harness.js";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import en from "../../webapp/messages/en.json";
import { restartHold } from "@ohmail/app-logic/doors/app-update";
import { enableDesktopDroppedFiles, installFileDropGuard } from "@ohmail/app-logic/write/dropped-files";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE STANDALONE DOOR OPENS GUIDED SETUP — driven through the chooser, not described
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE FAILURE THIS FILE PINS SHUT, measured on a released build by somebody walking the product
 * as a stranger: choose "On this computer", pick a provider, type the password — and the mail
 * client appears with nothing having asked anything. No welcome, no consent, no window, no
 * question about a model, no progress screen. The release notes said "a first run walks from 'I
 * installed ohmail' to a mailbox that is being organized"; on the main customer door it did not,
 * and the guided flow existed only behind Settings → Mailboxes → "Run setup".
 *
 * The stage itself was there and correct. What was missing was an ENTRY POINT: `AppShell` renders
 * it only at `#/first-run` — deliberately, *"the stage never opens itself"* — and on this door
 * nothing ever put that route on the window.
 *
 * ── WHY THIS IS DRIVEN THROUGH `DesktopGate` AND NOT ASSERTED ON THE SOURCE ─────────────────
 *
 * The seam is one line inside a callback three components deep, and the previous slice's own
 * tests for this flow assert on file TEXT (`toMatch(/goFirstRun\(\{ rerun: true \}\)/)`). Text
 * assertions cannot tell "the call is in the file" from "the call runs when somebody connects" —
 * which is exactly the distinction that was lost here, because the pane's entry point was written
 * and the door's was not, and the flow's own suite was green throughout. So this file presses the
 * real buttons against the real `enterLocalDoor`, over a stand-in shell, and reads the WINDOW'S
 * OWN ROUTE afterwards. Nothing about the assertion survives deleting the navigation.
 *
 * ── AND THE HOSTED DOOR IS THE NEGATIVE CONTROL ────────────────────────────────────────────
 *
 * `firstRunDoorFor` is the one door rule and it answers `null` for a cloud engine, so a cloud
 * entry must leave the route alone. Without that case the fix could be "navigate on every
 * connect", which would put a setup stage over an account whose setup belongs to the account.
 *
 * ── HOW TO WATCH IT FAIL ───────────────────────────────────────────────────────────────────
 *
 * Delete the `openSetupOnStandalone(r.status ?? null);` line from the `gate.kind === "choose"`
 * chooser in `DesktopGate.tsx` and the first case goes red with the route still `""` — which is
 * the released behaviour exactly. Change the guard inside `openSetupOnStandalone` to navigate
 * unconditionally and the cloud case goes red instead. Both mutations were run.
 */

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

function encode(status: number, body = "", statusText = "OK"): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText, h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const EMPTY_PAGE = JSON.stringify({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "MA",
  hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } });

/**
 * An install with no door yet — `not_configured`, which is what `gateFor` turns into the chooser.
 *
 * `engine_configure` moves it to `serving` under whichever mode it was handed, which is the whole
 * of what this test needs the shell to model: the door's own sequence (configure → settle → seal
 * → configure → settle) then runs for real against it.
 */
function freshInstall(shellFacts: Record<string, unknown> = {}): { urls: string[] } {
  const urls: string[] = [];
  let status: Record<string, unknown> = { state: "not_configured", mode: null, ...shellFacts };

  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_configure") {
        const config = payload!.config as { mode: string; address?: string };
        status = {
          state: "serving",
          mode: config.mode === "cloud" ? "cloud" : "local",
          address: config.address ?? "",
          mailboxId: "mbx-fresh",
          credentialState: "ready",
        };
        return status;
      }
      if (command === "engine_status") return status;
      if (command === "mailto_claim") return null;
      if (command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload!.url ?? "");
        urls.push(url);
        if (url === "/health") return encode(200, '{"signedIn":true}');
        if (url === "/cloud/probe") {
          return encode(200, JSON.stringify({ ok: true, target: "https://ohmail.app/hello", flavor: "cloud" }));
        }
        if (url === "/cloud/signin") return encode(200, '{"status":"signed_in"}');
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        /* THE SETTLED ROW, read by the first-connect order before it seals. It has to carry the
           ADDRESS that was configured: the door refuses to seal onto a row that names a different
           mailbox, which is what stops a first connect over a populated install from putting a
           newly typed password on the mailbox that install was already opening. */
        if (/^\/mailboxes\/[^/]+$/.test(url) && (payload!.method ?? "GET") === "GET") {
          return encode(200, JSON.stringify({
            id: "mbx-fresh", address: (status as { address?: string }).address ?? "",
          }));
        }
        // The credential seal, and every read the mounted client makes. A permissive 200 here is
        // right: this file is about the ROUTE the window ends on, and a refusal anywhere would
        // only ever make the assertion easier to pass by accident.
        if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [] }));
        if (url.startsWith("/consent")) return encode(200, JSON.stringify({ dormancyDays: 60 }));
        if (url.startsWith("/local/ai")) return encode(200, JSON.stringify({ provider: null }));
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
  return { urls };
}

let root: Root | null = null;
let mount: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
  await act(async () => {
    root!.render(
      h(
        NextIntlClientProvider,
        { locale: "en", messages: en as never, timeZone: "Europe/Zurich" },
        h(ThemeProvider, { storageKey: "ohmail.theme" }, h(ToastHost, null, h(DesktopGate, null))),
      ),
    );
  });
  await settle();
  return mount!;
}

/** Enough turns for the status reads, the door's two configures and the mount to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

async function type(el: HTMLElement, id: string, value: string): Promise<void> {
  const input = el.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no field #${id} on screen`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Open one of the three doors BY ITS NAME, never by a substring of the card.
 *
 * The self-hosted tile's own sentence is "Self-hosted ohmail Cloud." — so a `textContent`
 * search for "ohmail Cloud" finds the SERVER tile first and the test walks the wrong door with
 * no error until a field is missing. Matching `.door-name` exactly is what keeps the three
 * distinguishable.
 */
async function openDoor(el: HTMLElement, name: string): Promise<void> {
  const tile = [...el.querySelectorAll<HTMLButtonElement>(".door-tile")]
    .find((t) => (t.querySelector(".door-name")?.textContent ?? "").trim() === name);
  if (!tile) {
    throw new Error(
      `no door named "${name}" — found: ${
        [...el.querySelectorAll(".door-tile")].map((t) => t.querySelector(".door-name")?.textContent).join(" | ")
      }`,
    );
  }
  await act(async () => {
    tile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function press(el: HTMLElement, label: string): Promise<void> {
  const found = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
  if (!found) {
    throw new Error(
      `no button saying "${label}" — found: ${[...el.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`,
    );
  }
  await act(async () => {
    found.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  window.location.hash = "";
  localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mount?.remove();
  root = null;
  mount = null;
  delete host.__TAURI_INTERNALS__;
  window.location.hash = "";
  localStorage.clear();
});

const heldFile = { name: "notes.txt", size: 3, type: "text/plain", state: "ok" };
const heldData = { types: ["text/uri-list", "text/html"], files: [], getData: () => "" };

function fileDropShell(
  take: () => unknown = () => ({ drop: "fixture-drop", files: [heldFile] }),
  chunk: () => unknown = () => ({ bytes64: "YWJj", end: true }),
  armed = true,
) {
  window.location.hash = "#/compose";
  freshInstall({ state: "serving", mode: "local", mailboxId: "fixture-mailbox", credentialState: "ready" });
  const native = host.__TAURI_INTERNALS__!;
  const other = native.invoke;
  const commands: Array<{ command: string; payload?: Record<string, unknown> }> = [];
  native.invoke = async (command, payload) => {
    if (command === "dropped_files_take" || command === "dropped_file_chunk") {
      commands.push({ command, payload });
      return command === "dropped_files_take" ? take() : chunk();
    }
    return other(command, payload);
  };
  const disarm = armed ? enableDesktopDroppedFiles() : undefined;
  const unguard = installFileDropGuard(window);
  return { commands, dispose: () => { unguard(); disarm?.(); } };
}

async function openLetterForDrop(): Promise<HTMLElement> {
  const el = await render();
  const composer = el.querySelector<HTMLElement>(".oh-composer");
  if (composer === null) throw new Error("the desktop did not open a letter to write");
  return composer;
}

function answerLater<T>() {
  let answer!: (value: T) => void;
  const pending = new Promise<T>((resolve) => { answer = resolve; });
  return { pending, answer };
}

it("attaches a file held by the desktop after it is dropped on the open letter", async () => {
  const shell = fileDropShell();
  try {
    const composer = await openLetterForDrop();
    expect(fireEvent.dragOver(composer, { dataTransfer: heldData })).toBe(false);
    expect(fireEvent.drop(composer, { dataTransfer: heldData })).toBe(false);
    expect(await screen.findByText("notes.txt")).toBeDefined();
    expect(shell.commands).toEqual([
      { command: "dropped_files_take", payload: undefined },
      { command: "dropped_file_chunk", payload: { drop: "fixture-drop", index: 0 } },
    ]);

    const ordinary = new File(["another file"], "browser-file.txt", { type: "text/plain" });
    expect(fireEvent.drop(composer, { dataTransfer: { types: ["Files"], files: [ordinary] } })).toBe(false);
    expect(await screen.findByText("browser-file.txt")).toBeDefined();
    expect(shell.commands).toHaveLength(2);
  } finally {
    shell.dispose();
  }
});

it("holds restart through the desktop take, read, and attached file", async () => {
  const take = answerLater<unknown>();
  const read = answerLater<unknown>();
  const shell = fileDropShell(() => take.pending, () => read.pending);
  try {
    const composer = await openLetterForDrop();
    fireEvent.drop(composer, { dataTransfer: heldData });
    expect(restartHold()).toBe("files");
    await act(async () => { take.answer({ drop: "fixture-drop", files: [heldFile] }); });
    await waitFor(() => expect(shell.commands.map((c) => c.command)).toEqual(["dropped_files_take", "dropped_file_chunk"]));
    expect(restartHold()).toBe("files");
    expect(composer.textContent).toContain("notes.txt");
    expect(screen.queryByRole("button", { name: "Remove notes.txt" })).toBeNull();
    await act(async () => { read.answer({ bytes64: "YWJj", end: true }); });
    const remove = await screen.findByRole("button", { name: "Remove notes.txt" });
    expect(restartHold()).toBe("files");
    fireEvent.click(remove);
    await waitFor(() => expect(restartHold()).toBeNull());
  } finally {
    take.answer(null);
    read.answer(null);
    shell.dispose();
  }
});

it("stops reading later chunks when the letter closes", async () => {
  const read = answerLater<unknown>();
  const shell = fileDropShell(undefined, () => read.pending);
  try {
    const composer = await openLetterForDrop();
    fireEvent.drop(composer, { dataTransfer: heldData });
    await waitFor(() => expect(shell.commands).toHaveLength(2));
    expect(restartHold()).toBe("files");
    await act(async () => { root!.unmount(); });
    root = null;
    expect(restartHold()).toBeNull();
    await act(async () => { read.answer({ bytes64: "YQ==", end: false }); });
    expect(shell.commands.map((c) => c.command)).toEqual(["dropped_files_take", "dropped_file_chunk"]);
  } finally {
    read.answer(null);
    shell.dispose();
  }
});

it("leaves links and recipient chips alone and releases an empty desktop drop", async () => {
  const shell = fileDropShell(() => null);
  try {
    const composer = await openLetterForDrop();
    const link = { types: ["text/plain", "text/uri-list"], files: [], getData: () => "https://example.invalid/item" };
    const chip = { types: ["application/x-ohmail-recipient", "text/plain"], files: [] };
    for (const dataTransfer of [link, chip]) {
      expect(fireEvent.dragOver(composer, { dataTransfer })).toBe(true);
      expect(fireEvent.drop(composer, { dataTransfer })).toBe(true);
    }
    expect(shell.commands).toEqual([]);
    expect(fireEvent.drop(composer, { dataTransfer: heldData })).toBe(false);
    await waitFor(() => expect(restartHold()).toBeNull());
    expect(shell.commands.map((c) => c.command)).toEqual(["dropped_files_take"]);
    expect(screen.queryByText("notes.txt")).toBeNull();
  } finally {
    shell.dispose();
  }
});

it("says why refused files could not attach without reading any chunks", async () => {
  const shell = fileDropShell(() => ({
    drop: "fixture-drop", files: [
      { ...heldFile, name: "large.txt", state: "too_large" },
      { ...heldFile, name: "over-letter-limit.txt", size: 10 ** 12 },
      { ...heldFile, name: "unreadable.txt", state: "unreadable" },
    ],
  }));
  try {
    const composer = await openLetterForDrop();
    fireEvent.drop(composer, { dataTransfer: heldData });
    await waitFor(() => expect(restartHold()).toBeNull());
    expect(composer.textContent).toContain(en.write.files.unreadable);
    expect(composer.textContent).toContain(en.write.files.refused.split("{size}")[0]);
    expect(shell.commands.map((c) => c.command)).toEqual(["dropped_files_take"]);
  } finally {
    shell.dispose();
  }
});

it("passes a withheld drag without a native pick when the window is unarmed", async () => {
  const shell = fileDropShell(undefined, undefined, false);
  try {
    const composer = await openLetterForDrop();
    expect(fireEvent.dragOver(composer, { dataTransfer: heldData })).toBe(true);
    expect(fireEvent.drop(composer, { dataTransfer: heldData })).toBe(false);
    expect(shell.commands).toEqual([]);
    expect(screen.queryByText("notes.txt")).toBeNull();
  } finally {
    shell.dispose();
  }
});

describe("connecting on the standalone door opens guided setup", () => {
  it("THE MAIN CUSTOMER DOOR — provider, address, password, and the window is at #/first-run", async () => {
    freshInstall();
    const el = await render();

    // The chooser is what a fresh install lands on. If this throws, the test is asserting
    // against a screen that is not the one the defect was reported on.
    expect(el.textContent).toContain("Which mailbox is this?");
    expect(window.location.hash, "nothing has been asked for yet").toBe("");

    await openDoor(el, "On this computer");
    await press(el, "Any other IMAP mailbox");
    await type(el, "door-address", "peter@example.test");
    await type(el, "door-password", "a-mailbox-password");
    await type(el, "door-imap-host", "imap.example.test");
    await press(el, "Open this mailbox");

    /* THE WHOLE ASSERTION. `#/first-run` is the only route at which `AppShell` renders the stage
       at all, so this is "the guided flow opened" stated in the one term the shell reads. On the
       released build this was `""` — the mail client, and nothing having asked anything. It names
       the mailbox the engine serves, so the stage is about the one just connected. */
    expect(window.location.hash).toBe("#/first-run?mailbox=mbx-fresh");
  });

  it("NOT A RE-RUN. The route is the first run's, so the flow opens where the facts say", async () => {
    /* `#/first-run/again` pre-fills from what the account stored and — by design — takes its
       navigation from the cursor rather than from the derivation, because a finished account
       derives to "nothing to do". Sending a FIRST run down that route would put somebody who has
       consented to nothing on a screen written for somebody who has. One character apart in the
       hash, and the two behave differently at every write. */
    freshInstall();
    const el = await render();
    await openDoor(el, "On this computer");
    await press(el, "Any other IMAP mailbox");
    await type(el, "door-address", "peter@example.test");
    await type(el, "door-password", "a-mailbox-password");
    await type(el, "door-imap-host", "imap.example.test");
    await press(el, "Open this mailbox");

    expect(window.location.hash).not.toMatch(/^#\/first-run\/again/);
    expect(window.location.hash).toBe("#/first-run?mailbox=mbx-fresh");
  });

  it("THE HOSTED DOOR NAVIGATES NOWHERE — that account's setup is not this install's", async () => {
    freshInstall();
    const el = await render();

    await openDoor(el, "ohmail Cloud");
    /* The first-run Cloud door opens on the browser approval; the password form is one press away,
       and it is the one path here that signs in without a browser. */
    await press(el, "Use my password instead");
    await type(el, "cloud-address", "someone@ohmail.app");
    await type(el, "cloud-password", "a-password-long-enough");
    await type(el, "cloud-totp", "123456");
    await press(el, "Sign in");

    /* `firstRunDoorFor` answers `null` on a cloud engine, so `useLocalFirstRun` hands `AppShell`
       no host and `#/first-run` would draw nothing whatever the route said. Navigating there
       anyway would be a dead route on a working install. */
    expect(window.location.hash).toBe("");
  });
});

/**
 * AFTER A REFUSED FIRST DOOR UNDER ONE ADDRESS AND A SUCCESSFUL ONE UNDER ANOTHER, the install holds
 * both rows, the refused attempt's first. The setup is about the mailbox just connected: its consent
 * lands there and the bare row stays unconsented. Unnamed, the stage took the first row.
 */
function twoAttempts(): { organized: string[] } {
  const organized: string[] = [];
  const ids: Record<string, string> = { "box1@home.arpa": "mbx-typo", "box2@home.arpa": "mbx-mila" };
  let status: Record<string, unknown> = { state: "not_configured", mode: null };
  const row = (id: string, address: string, createdAt: string) => ({
    id, address, status: "connected", errorCode: null, disabledReason: null, syncBlockedReason: null,
    syncBlockedSince: null, lastSyncAt: null, initialImportCompletedAt: null, createdAt,
    organizerRole: "reader", organizedBy: null, organizerState: null, organizeConsentedAt: null,
    organizerChecked: true,
  });
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_configure") {
        const config = payload!.config as { address?: string };
        const address = config.address ?? "";
        status = { state: "serving", mode: "local", address, mailboxId: ids[address] ?? "mbx-other", credentialState: "ready" };
        return status;
      }
      if (command === "engine_status") return status;
      if (command === "mailto_claim" || command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload!.url ?? "");
        const method = String((payload as { method?: unknown }).method ?? "GET");
        const one = /^\/mailboxes\/([^/?]+)$/.exec(url);
        if (one && method === "GET") {
          const address = Object.keys(ids).find((a) => ids[a] === one[1]) ?? "";
          return encode(200, JSON.stringify({ id: one[1], address }));
        }
        const seal = /^\/local\/mailboxes\/([^/]+)$/.exec(url);
        if (seal && method === "PATCH") {
          if (seal[1] === "mbx-typo") {
            return encode(400, JSON.stringify({ error: {
              code: "mailbox_probe_failed", message: "The mail server refused that password.",
              details: { reason: "auth", transport: "imap" },
            } }), "Bad Request");
          }
          return encode(200, JSON.stringify({ id: seal[1] }));
        }
        const org = /^\/local\/mailboxes\/([^/]+)\/organize$/.exec(url);
        if (org && method === "POST") { organized.push(org[1]!); return encode(200, "{}"); }
        if (url.startsWith("/mailboxes")) {
          return encode(200, JSON.stringify({ items: [
            row("mbx-typo", "box1@home.arpa", "2026-09-29T08:00:00.000Z"),
            row("mbx-mila", "box2@home.arpa", "2026-09-29T08:01:00.000Z"),
          ] }));
        }
        if (url === "/health") return encode(200, '{"signedIn":true}');
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/consent")) return encode(200, JSON.stringify({ dormancyDays: 60 }));
        if (url.startsWith("/local/ai")) return encode(200, JSON.stringify({ provider: null }));
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
  return { organized };
}

describe("the setup after a retried first door", () => {
  it("is about the mailbox just connected — its consent lands there, the refused row keeps none", async () => {
    const shell = twoAttempts();
    const el = await render();
    await openDoor(el, "On this computer");
    await press(el, "Any other IMAP mailbox");
    await type(el, "door-address", "box1@home.arpa");
    await type(el, "door-password", "a-mailbox-password");
    await type(el, "door-imap-host", "imap.home.arpa");
    await press(el, "Open this mailbox");
    expect(el.textContent, "control: the first attempt was refused").toContain("refused that password");
    await type(el, "door-address", "box2@home.arpa");
    await press(el, "Open this mailbox");
    await press(el, "Continue");
    await press(el, "Agree and start organizing");
    expect(shell.organized, "the consent went to another mailbox").toEqual(["mbx-mila"]);
    expect(window.location.hash).toBe("#/first-run?mailbox=mbx-mila");
  });
});

/**
 * THE GATE HANDS THE CHOOSER THE SHELL'S PATH. `engine_status` names the one file the operator's
 * certificate authority is read from; the first-run chooser's server door says that path, handed
 * down by the gate rather than asked for again.
 */
describe("the first-run chooser names where a private certificate authority goes", () => {
  it("says the path engine_status names under the server door's address field", async () => {
    freshInstall({ operatorCaFile: "/data/ohmail/cloud-ca.pem" });
    const el = await render();
    expect(el.textContent).toContain("Which mailbox is this?");
    await openDoor(el, "Your own server");
    const hint = [...el.querySelectorAll(".join-hint")].map((p) => p.textContent ?? "")
      .find((t) => t.includes("root certificate")) ?? "";
    expect(hint).toContain("save its root certificate as /data/ohmail/cloud-ca.pem first.");
  });
});

describe("connecting a mailbox in desktop setup", () => {
  const address = "second@inbox.example";
  const login = ["sample", "login"].join("-");
  const incoming = "imap.example.org";
  const outgoing = "smtp.example.org";
  const copy = en.onboarding;
  const say = createTranslator({ locale: "en", messages: copy });
  let pipe: Pipe | undefined;

  afterEach(() => {
    pipe?.unplant();
    window.history.replaceState(null, "", "/");
    localStorage.clear();
  });

  type RequestBody = { address: string; imap: Record<string, unknown>; smtp: Record<string, unknown> };

  async function open(mode: "add" | "seed", refusal = false, pending?: Promise<void>) {
    const writes: { path: string; method: string; body: RequestBody }[] = [];
    const first = { id: "mbx-first", address: "first@inbox.example" };
    const rows = mode === "add" ? [first] : [];
    window.history.replaceState(null, "", mode === "add" ? "#/first-run/add" : "#/first-run");
    pipe = plantShell(DOORS["D-l"](first), async (req) => {
      const path = new URL(req.url).pathname;
      if (req.method === "POST" && path.startsWith("/local/mailboxes")) {
        writes.push({ path, method: req.method, body: await req.json() as RequestBody });
        if (pending && path === "/local/mailboxes/probe") await pending;
        if (refusal) return Response.json({ error: {
          code: "mailbox_probe_failed", message: "Mail server refused", details: { reason: "auth", transport: "imap" },
        } }, { status: 422 });
        if (path === "/local/mailboxes/probe") return Response.json({
          host: incoming, user: address, folders: 12, sending: writes.at(-1)?.body.smtp
            ? { state: "refused", host: outgoing, reason: "auth" } : { state: "not_configured" },
        });
        rows.push({ id: "mbx-second", address });
        return Response.json({ id: "mbx-second" }, { status: 201 });
      }
      if (path === "/mailboxes") return Response.json({ items: rows.map((row) => ({
        ...row, status: "active", organizerChecked: true, createdAt: "2026-01-01", organizeConsentedAt: "2026-01-01",
      })) });
      if (path === "/consent") return Response.json({
        dormancyDays: 60, onboardingCompletedAt: mode === "add" ? "2026-01-01" : null, seedConfirmedAt: "2026-01-01",
      });
      if (path === "/sync/snapshot") return Response.json({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } });
      return Response.json({ items: [], changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "MA", hasMore: false, serverTime: "2026-01-01T00:00:00Z" });
    }, "fixture");
    await render();
    if (mode === "seed") await press(copy.welcomeStart);
    await waitFor(() => expect(screen.queryByRole("heading", { name: copy.mailboxTitle }) !== null).toBe(true));
    const field = (name: string, value: string) => {
      const input = screen.queryByLabelText(name);
      if (!input) throw new Error(`Setup did not draw the ${name} field`);
      fireEvent.change(input, { target: { value } });
    };
    async function fill() {
      field(copy.address, address);
      await press(en.providerPicker.otherLabel);
      field(copy.imapHost, incoming + ":993");
      field(copy.smtpHost, outgoing + ":465");
      field(copy.password, login);
    }
    await fill();
    return { writes, commands: pipe.commands, asked: pipe.asked, field, fill };
  }

  async function press(label: string) {
    const button = () => screen.queryByRole("button", { name: (name) => name.startsWith(label) });
    await waitFor(() => expect(button() !== null).toBe(true));
    await act(async () => { fireEvent.click(button()!); });
  }

  it("ADD posts to the local add route and never reconfigures the install", async () => {
    const { writes, commands, asked } = await open("add");
    await press(copy.connect);
    expect(asked.filter((call) => call.startsWith("POST ") && call.includes("/mailboxes"))).toEqual(["POST /local/mailboxes"]);
    expect(commands).not.toContain("engine_configure");
    const body = writes[0]!.body;
    expect(body.address === address).toBe(true);
    expect(body.imap.host).toBe(incoming);
    expect(body.imap.port).toBe(993);
    expect(body.imap.smtpUnsettled).toBe("");
    expect(body.smtp.host).toBe(outgoing);
    expect(body.smtp.port).toBe(465);
    expect(body.imap.user === address && body.smtp.user === address).toBe(true);
    expect(body.imap.pass === login && body.smtp.pass === login).toBe(true);
    expect(window.location.hash).toBe("#/first-run/add?mailbox=mbx-second");
  });

  it("SEED reconfigures the install", async () => {
    const { commands, asked } = await open("seed");
    await press(copy.connect);
    expect(commands).toContain("engine_configure");
    expect(asked).not.toContain("POST /local/mailboxes");
  });

  it("carries the OUTGOING server too, without a second copy of the password", async () => {
    const { writes } = await open("add");
    await press(copy.test);
    const body = writes[0]!.body;
    expect(body.smtp.host).toBe(outgoing);
    expect(body.smtp.port).toBe(465);
    expect("pass" in body.smtp).toBe(false);
    expect(body.imap.pass === login).toBe(true);
    expect(screen.queryByText(say("probeOk", { host: incoming, user: address, count: 12 })) !== null).toBe(true);
    expect(screen.queryByText(say("sendingRefusedAuth", { host: outgoing })) !== null).toBe(true);
  });

  it("the probe is the engine's own dial and sends no username it was not given", async () => {
    const { writes } = await open("add");
    await press(copy.test);
    expect(writes.map(({ method, path }) => [method, path])).toEqual([["POST", "/local/mailboxes/probe"]]);
    expect("user" in writes[0]!.body.imap || "user" in writes[0]!.body.smtp).toBe(false);
  });

  it("sends a different login entered for the mailbox to both servers", async () => {
    const { writes, field } = await open("add");
    field(copy.user, "another-login");
    await press(copy.test);
    expect(writes[0]!.body.imap.user).toBe("another-login");
    expect(writes[0]!.body.smtp.user).toBe("another-login");
  });

  it("a refusal from the engine says why the mailbox could not be connected", async () => {
    await open("add", true);
    await press(copy.connect);
    expect(screen.queryByText(en.mailboxes.probe_auth) !== null).toBe(true);
    expect(window.location.hash).toBe("#/first-run/add");
  });

  for (const mode of ["add", "seed"] as const) {
    it(`can test and connect an incoming-only mailbox during ${mode} setup`, async () => {
      const { writes, field, commands } = await open(mode);
      field(copy.smtpHost, "");
      await press(copy.test);
      expect(writes.map(({ path }) => path)).toEqual(["/local/mailboxes/probe"]);
      expect("smtp" in writes[0]!.body).toBe(false);
      expect(screen.queryByText(copy.sendingNotSet) !== null).toBe(true);
      await press(copy.connect);
      if (mode === "seed") expect(commands).toContain("engine_configure");
      else {
        expect(writes[1]!.path).toBe("/local/mailboxes");
        expect("smtp" in writes[1]!.body).toBe(false);
        expect(window.location.hash).toBe("#/first-run/add?mailbox=mbx-second");
      }
    });
  }

  async function navigate(hash: string) {
    await act(async () => {
      window.history.replaceState(null, "", hash);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  for (const refuses of [false, true]) {
    it(`keeps a local Test pending across setup re-entry until the engine ${refuses ? "refuses" : "answers"}`, async () => {
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      const { field, fill, writes } = await open("add", refuses, pending);
      try {
        field(copy.imapHost, "localhost:1143");
        await press(copy.test);
        expect(screen.queryByText(copy.testingLocal) !== null).toBe(true);
        await navigate("#/ohbox");
        expect(screen.queryByLabelText(copy.password) === null).toBe(true);
        await navigate("#/first-run/add");
        await fill();
        field(copy.imapHost, "localhost:1143");
        const button = screen.getByRole<HTMLButtonElement>("button", { name: copy.test });
        expect(button.disabled).toBe(true);
        expect(screen.queryByText(copy.testingLocal) !== null).toBe(true);
        fireEvent.click(button);
        expect(writes.length).toBe(1);
        await act(async () => { finish(); });
        expect(button.disabled).toBe(false);
        expect(screen.queryByText(copy.testingLocal)).toBeNull();
      } finally {
        await act(async () => { finish(); });
      }
    });
  }

  for (const { how, refuses } of [{ how: "press", refuses: false }, { how: "submit", refuses: true }]) {
    it(`a Connect ${how} waits for a pending local Test after re-entry`, async () => {
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      const { field, fill, writes } = await open("add", refuses, pending);
      try {
        field(copy.imapHost, "localhost:1143");
        await press(copy.test);
        await navigate("#/ohbox");
        await navigate("#/first-run/add");
        await fill();
        const connect = screen.getByRole<HTMLButtonElement>("button", { name: (name) => name.startsWith(copy.connect) });
        const attempt = () => how === "submit" ? fireEvent.submit(connect.form!) : fireEvent.click(connect);
        await act(async () => { attempt(); });
        expect(writes.map(({ path }) => path)).toEqual(["/local/mailboxes/probe"]);
        expect(connect.disabled).toBe(true);
        await act(async () => { finish(); });
        expect(connect.disabled).toBe(false);
        await act(async () => { attempt(); });
        expect(writes.map(({ path }) => path)).toEqual(["/local/mailboxes/probe", "/local/mailboxes"]);
      } finally {
        await act(async () => { finish(); });
      }
    });
  }

  it("shows the ordinary wait while a remote mail server answers a Test", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    await open("add", false, pending);
    try {
      await press(copy.test);
      expect(screen.queryByRole("button", { name: (name) => name.includes(incoming) }) !== null).toBe(true);
      expect(screen.queryByText(copy.testingLocal)).toBeNull();
    } finally {
      await act(async () => { finish(); });
    }
  });
});

it("keeps a withheld drop with the letter it landed on when a mail link replaces the letter", async () => {
  const { enableExternalLinks, interceptLinkClicks } = await import("@ohmail/app-logic/session/open-external");
  const take = answerLater<unknown>();
  const shell = fileDropShell(() => take.pending);
  const link = document.createElement("a");
  link.href = "mailto:other@example.invalid?subject=Replacement%20letter";
  link.textContent = "Write to another person";
  document.body.append(link);
  enableExternalLinks();
  const unintercept = interceptLinkClicks(document, { trustSameOrigin: true });
  try {
    const composer = await openLetterForDrop();
    expect(fireEvent.drop(composer, { dataTransfer: heldData })).toBe(false);
    await waitFor(() => expect(shell.commands.map((c) => c.command)).toEqual(["dropped_files_take"]));
    expect(restartHold()).toBe("files");
    expect(fireEvent.click(link)).toBe(false);
    await screen.findByDisplayValue("Replacement letter");
    expect(window.location.hash).toBe("#/compose");
    expect(composer.isConnected).toBe(true);
    expect(restartHold()).toBeNull();

    await act(async () => take.answer({ drop: "fixture-drop", files: [heldFile] }));
    expect(shell.commands.map((c) => c.command)).toEqual(["dropped_files_take"]);
    expect(screen.queryByRole("button", { name: "Remove notes.txt" })).toBeNull();
    expect(restartHold()).toBeNull();
  } finally {
    take.answer(null);
    unintercept();
    link.remove();
    shell.dispose();
  }
});

it.each(["file picker", "browser drop"])("leaves a pending %s attachment with the letter it started on", async (input) => {
  const { enableExternalLinks, interceptLinkClicks } = await import("@ohmail/app-logic/session/open-external");
  const reached = answerLater<() => void>();
  const shell = fileDropShell();
  const file = new File(["original letter attachment"], "earlier-letter.txt", { type: "text/plain" });
  const read = FileReader.prototype.readAsDataURL;
  const reader = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader, blob) {
    const receive = this.onload;
    this.onload = (event) => { reached.answer(() => receive?.call(this, event)); };
    read.call(this, blob);
  });
  const link = document.createElement("a");
  link.href = "mailto:replacement@example.invalid?subject=Another%20letter";
  document.body.append(link);
  enableExternalLinks();
  const unintercept = interceptLinkClicks(document, { trustSameOrigin: true });
  try {
    const composer = await openLetterForDrop();
    if (input === "file picker") {
      const picker = composer.querySelector<HTMLInputElement>('input[type="file"]');
      expect(picker).not.toBeNull();
      fireEvent.change(picker!, { target: { files: [file] } });
    } else {
      fireEvent.drop(composer, { dataTransfer: { types: ["Files"], files: [file] } });
    }
    const finish = await reached.pending;
    expect(restartHold()).toBe("files");
    expect(fireEvent.click(link)).toBe(false);
    await screen.findByDisplayValue("Another letter");
    expect(composer.isConnected).toBe(true);
    await act(async () => { finish(); });
    expect(screen.queryByText("earlier-letter.txt")).toBeNull();
    expect(restartHold()).toBeNull();
    expect(shell.commands).toEqual([]);
  } finally {
    reader.mockRestore();
    unintercept();
    link.remove();
    shell.dispose();
  }
});
