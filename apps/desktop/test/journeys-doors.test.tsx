/** @vitest-environment jsdom */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { createSidecar, type Sidecar } from "../../sidecar/src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "../../sidecar/test/pglite-budget.js";
import { DesktopGate } from "../src/DesktopGate.js";
import messages from "../../webapp/messages/en.json";
import { DOORS, plantShell, type Pipe } from "./_doors-harness.js";

/**
 * THE DESKTOP'S FOUR DOORS, READ AS A PERSON WOULD: which Settings sections each lists, by role and
 * name, and what the window asked its engine on the way. The window bundle cannot run in a browser
 * (its every call needs the shell), so the gate is drawn in jsdom over a recording pipe to a REAL
 * engine; the engine's status is planted per door.
 *
 * What this reading is and is not: the engine behind every door here is the desktop's own (local)
 * engine. On the three signed-in doors it stands in for an engine that relays to an account, so
 * what those doors show ONLY with a live hosted session is not reached here.
 */
vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS + 60_000 });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
})) as never;

type Catalogue = { [key: string]: string | Catalogue };
/** The catalogue's words for a dotted key. */
const say = (key: string): string => key.split(".").reduce<string | Catalogue>((at, part) => (at as Catalogue)[part]!, messages as Catalogue) as string;

/** The names of the buttons inside the navigation landmark called `name`, as a screen reader lists them. */
function listed(el: HTMLElement, name: string): string[] {
  const nav = [...el.querySelectorAll("nav")].filter((n) => n.getAttribute("aria-label") === name);
  if (nav.length !== 1) throw new Error(`${nav.length} navigation landmarks are called ${JSON.stringify(name)}, expected one`);
  return [...nav[0]!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? (b.textContent ?? "").trim());
}

/** What each door's Settings menu lists today, by the catalogue key of each name. */
const SIGNED_IN = [
  "settings.general", "settings.notifications", "settings.mailboxes", "settings.screener", "settings.ai", "settings.away",
  "settings.rules", "settings.tags", "settings.signatures.nav", "desktopDoor.paneLabel", "settings.devices",
  "settings.security", "settings.account", "settings.about", "settings.help",
];
const SEEN: Record<keyof typeof DOORS, string[]> = {
  "D-l": [
    "settings.general", "settings.notifications", "settings.mailboxes", "settings.screener", "settings.away", "settings.rules",
    "settings.tags", "settings.signatures.nav", "desktopDoor.paneLabel", "settings.devices", "settings.about", "settings.help",
  ],
  "D-m": SIGNED_IN,
  "D-s": SIGNED_IN,
  "D-p": [
    "settings.general", "settings.notifications", "settings.mailboxes", "settings.screener", "settings.away", "settings.rules",
    "settings.tags", "settings.signatures.nav", "desktopDoor.paneLabel", "settings.about", "settings.help",
  ],
};

let dir = "";
let sidecar: Sidecar;
let mailbox = { id: "", address: "mila@lichtgrat.example" };
let root: Root | null = null;
let mount: HTMLElement | null = null;
let pipe: Pipe | null = null;

const settle = async (rounds = 40): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
};

beforeAll(async () => {
  // The engine's store reads its bundles as Node's own Blob; jsdom's has no arrayBuffer().
  (globalThis as { Blob: unknown }).Blob = NodeBlob;
  dir = mkdtempSync(join(tmpdir(), "ohmail-journeys-doors-"));
  sidecar = await createSidecar({
    dataDir: join(dir, "data"),
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: mailbox.address, pass: ["app", "word", "9f3a"].join("-") } },
    adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    log: () => undefined, dkimKeys: null,
  });
  const listed = await sidecar.handle(new Request("http://sidecar/mailboxes", { headers: { authorization: `Bearer ${sidecar.sessionToken}` } }));
  const { items } = await listed.json() as { items: Array<{ id: string; address: string }> };
  mailbox = { id: items[0]!.id, address: items[0]!.address };
}, PGLITE_STANDUP_BUDGET_MS);

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mount?.remove();
  root = null;
  mount = null;
  pipe?.unplant();
  pipe = null;
  window.location.hash = "";
  localStorage.clear();
});

afterAll(async () => {
  await sidecar?.stop().catch(() => undefined);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function open(door: keyof typeof DOORS): Promise<HTMLElement> {
  window.location.hash = "#/settings";
  pipe = plantShell(DOORS[door](mailbox), (req) => sidecar.handle(req), sidecar.sessionToken);
  mount = document.createElement("div");
  document.body.appendChild(mount);
  root = createRoot(mount);
  await act(async () => {
    root!.render(
      <IntlProvider locale="en" messages={messages as never} timeZone="UTC">
        <ThemeProvider storageKey="ohmail.theme"><ToastHost><DesktopGate /></ToastHost></ThemeProvider>
      </IntlProvider>,
    );
  });
  await settle();
  return mount;
}

describe("journeys · the desktop's doors · jsdom over a real engine, status planted", () => {
  for (const door of Object.keys(DOORS) as Array<keyof typeof DOORS>) {
    it(`${door}: Settings lists this door's sections, and the window asks only its engine`, async () => {
      const el = await open(door);
      const menu = listed(el, say("settings.navAria"));
      const record = process.env.TF_JOURNEYS_RECORD;
      if (record) {
        // For the table per setting: each section's controls by name, and what Trash says.
        const rail = listed(el, say("rail.ariaMain"));
        const panes: Record<string, string[]> = {};
        const nav = [...el.querySelectorAll("nav")].find((n) => n.getAttribute("aria-label") === say("settings.navAria"))!;
        for (const entry of [...nav.querySelectorAll("button")]) {
          await act(async () => { entry.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
          await settle(30);
          const region = [...el.querySelectorAll('[role="region"]')].find((r) => r.getAttribute("aria-label") === say("settings.title"));
          panes[(entry.textContent ?? "").trim()] = [...(region?.querySelectorAll('button, [role="switch"], input, textarea, a[href], h2, [role="status"]') ?? [])]
            .map((c) => `${c.getAttribute("role") ?? c.tagName.toLowerCase()}: ${(c.getAttribute("aria-label") ?? c.textContent ?? "").trim().slice(0, 90)}`);
        }
        window.location.hash = "#/trash";
        await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
        await settle(30);
        const trash = [...el.querySelectorAll('[role="listbox"]')].map((l) => (l.textContent ?? "").trim().slice(0, 160));
        mkdirSync(join(record, door), { recursive: true });
        writeFileSync(join(record, door, "settings.json"), JSON.stringify({
          how: "jsdom · real engine · status planted", menu, rail, panes, trash,
          commands: [...new Set(pipe!.commands)].sort(),
        }, null, 1));
        writeFileSync(join(record, door, "settings.calls.json"), JSON.stringify([...new Set(pipe!.asked)].sort(), null, 1));
      }
      // Which sections, never where each stands in the menu.
      expect([...menu].sort()).toEqual(SEEN[door].map(say).sort());
      // The window has no network: everything it asked went down the pipe, to paths of its own engine.
      expect(pipe!.asked.filter((a) => !/^[A-Z]+ \//.test(a))).toEqual([]);
    });
  }
});
