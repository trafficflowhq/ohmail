/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { createSidecar, type Sidecar } from "../../../test/support/sidecar-fixtures.js";
import { PGLITE_STANDUP_BUDGET_MS } from "../../../test/support/sidecar-fixtures.js";
import { DesktopGate } from "../src/DesktopGate.js";
import { en as messages } from "../../../test/support/web-catalogues.js";
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
      const nav = within(el).getByRole("navigation", { name: say("settings.navAria") });
      const entries = within(nav).getAllByRole("button");
      const menu = entries.map((entry) => entry.getAttribute("aria-label"));
      // Which sections, never where each stands in the menu.
      expect([...menu].sort()).toEqual(SEEN[door].map(say).sort());
      // The window has no network: everything it asked went down the pipe, to paths of its own engine.
      expect(pipe!.asked.filter((a) => !/^[A-Z]+ \//.test(a))).toEqual([]);
    });
  }
});
