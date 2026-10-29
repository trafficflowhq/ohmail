/** @vitest-environment jsdom */
/**
 * THE SIGN-IN AFTER A REUSE SWEEP IS TOLD OF IT, ONCE, IN ONE QUIET LINE. The session read's
 * `reuseSweeps` reach the account strip through the per-owner feed; Details opens the list and the
 * advice; OK sends one acknowledgement and the strip goes at once, a re-read while that is out does
 * not bring it back, and a refused one does. Another account's jar shows nothing of this one's feed.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const S = en.settings;
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fresh id per case: an acknowledged sweep stays put away for the life of the page. */
let sweep = { id: "", at: "2026-10-28T18:32:49.000Z", client: "web" };
let listed: unknown[] | undefined;
let acks: unknown[] = [];
let ackAnswer: () => Promise<Response>;
const realFetch = globalThis.fetch;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  sweep = { ...sweep, id: randomUUID() };
  listed = [sweep];
  acks = [];
  ackAnswer = async () => new Response(null, { status: 204 });
  document.cookie = "tf_owner=acct_A; Path=/";
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/auth/reuse-sweeps/ack")) {
      acks.push(JSON.parse(String(init?.body)));
      return ackAnswer();
    }
    if (u.includes("/auth/session")) {
      return json({
        scope: "full", user: { userId: "u-a", accountId: "acct_A", email: "a@lichtgrat.example", displayName: "A" },
        ...(listed ? { reuseSweeps: listed } : {}),
      });
    }
    return json({});
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  globalThis.fetch = realFetch;
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
});

/** The session read the shell's confirm makes, which publishes the feed. */
async function read(): Promise<void> {
  const { auth } = await import("../app/api-client");
  await act(async () => { await auth.session(); });
}

async function mount(locale: "en" | "de" = "en"): Promise<void> {
  const { ReuseSweepStrip } = await import("../app/(product)/mailbox/ReuseSweepStrip");
  await act(async () => {
    root.render(h(NextIntlClientProvider, { locale, messages: locale === "en" ? en : de, timeZone: "UTC", children: h(ReuseSweepStrip) }));
  });
}

const settle = (): Promise<void> => act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
/** How many times the strip names the swept browser: once is shown once. */
const told = (): number => (host.textContent ?? "").split(S.reuseClientWeb).length - 1;
const pressOk = async (): Promise<void> => {
  const ok = [...host.querySelectorAll("button")].find((b) => b.textContent === S.reuseSweepsOk);
  expect(ok, "no OK on the strip").toBeDefined();
  await act(async () => { ok!.click(); });
  await settle();
};
const details = (): HTMLButtonElement | undefined =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === S.reuseSweepsDetails);
const pressDetails = async (): Promise<void> => {
  expect(details(), "no Details on the strip").toBeDefined();
  await act(async () => { details()!.click(); });
};
/** Four sweeps on one boot: two browsers and two copies of the Linux app. */
const four = (): typeof sweep[] => ["web", "desktop-linux", "web", "desktop-linux"].map((client) => ({ ...sweep, id: randomUUID(), client }));

describe("the reuse sweeps a new sign-in is told of", () => {
  it("are shown once; OK sends one acknowledgement with the ids, and the strip goes", async () => {
    await read();
    await mount();
    expect(host.textContent).toContain("ohmail signed out an older copy of your sign-in.");
    expect(told(), "the list stands before Details").toBe(0);
    await pressDetails();
    expect(told()).toBe(1);
    await pressOk();
    expect(acks).toEqual([{ ids: [sweep.id] }]);
    expect(told()).toBe(0);
    await read();
    expect(told(), "a later read brought an acknowledged sweep back").toBe(0);
  });

  it("a re-read while the acknowledgement is out does not bring it back; a refused one does", async () => {
    let answer!: (r: Response) => void;
    ackAnswer = () => new Promise<Response>((resolve) => { answer = resolve; });
    await read();
    await mount();
    await pressDetails();
    await pressOk();
    expect(told(), "OK did not take the strip away at once").toBe(0);
    await read();
    expect(told(), "a read while the press was out brought it back").toBe(0);
    await act(async () => { answer(json({ error: { code: "db_busy", message: "busy" } }, 503)); });
    await settle();
    expect(details(), "a refused acknowledgement left nothing to press").toBeDefined();
    expect(acks).toHaveLength(1);
  });

  it("another account's jar shows nothing of this account's feed; nothing listed draws nothing", async () => {
    await read();
    document.cookie = "tf_owner=acct_B; Path=/";
    await mount();
    expect(told()).toBe(0);
    document.cookie = "tf_owner=acct_A; Path=/";
    listed = undefined;
    await read();
    expect(told()).toBe(0);
    expect(host.querySelector("button")).toBeNull();
  });

  it("four say one line; Details shows each with its date and the advice, and OK acknowledges all four", async () => {
    const all = four();
    listed = all;
    await read();
    await mount();
    expect(host.textContent).toContain("ohmail signed out 4 older copies of your sign-in.");
    expect(host.textContent, "the advice stands before Details").not.toContain(S.reuseSweepsBody);
    expect(details()!.getAttribute("aria-expanded")).toBe("false");
    await pressDetails();
    expect(details()!.getAttribute("aria-expanded")).toBe("true");
    const items = [...host.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toHaveLength(4);
    expect(items[1]).toMatch(new RegExp(`^${S.reuseClientLinux}, .*2026`));
    expect(host.textContent).toContain(S.reuseSweepsBody);
    await pressDetails();
    expect(host.querySelectorAll("li"), "Details closes again").toHaveLength(0);
    await pressOk();
    expect(acks).toEqual([{ ids: all.map((s) => s.id) }]);
    expect(host.querySelector("button")).toBeNull();
  });
});

/**
 * ONE LINE HIGH. The notice stood above the shell as a bold title, a list and a paragraph, the
 * whole top of the window on boot. Laid out in Chromium under the window's sheets: the sentence,
 * Details and OK on one row, the box one line high, from the desktop's 390 px minimum window to
 * 1440 px, in English and German, on paper and in the ohmarchy look. A sentence cut short on a
 * narrow window is read whole once Details is open.
 */
describe("the reuse notice in the window", () => {
  const SHEETS = [
    "packages/tokens/src/tokens.css", "packages/tokens/src/faces.css", "packages/tokens/src/ohmarchy.css",
    "packages/ui/src/base.css", "apps/webapp/app/app.css",
  ].map((p) => readFileSync(resolve(process.cwd(), p), "utf8")).join("\n");
  let browser: Awaited<ReturnType<typeof import("@playwright/test")["chromium"]["launch"]>> | null = null;

  beforeAll(async () => {
    const { chromium } = createRequire(resolve(process.cwd(), "package.json"))("@playwright/test") as typeof import("@playwright/test");
    browser = await chromium.launch();
  }, 120_000);
  afterAll(async () => { await browser?.close(); });

  const lay = async (html: string, width: number, face: string) => {
    const page = await browser!.newPage({ viewport: { width, height: 800 } });
    try {
      await page.setContent(`<!doctype html><html${face ? ` data-face="${face}"` : ""}><head><meta charset="utf-8"><style>${SHEETS}</style></head>
        <body class="mo-canvas app-body">${html}<div class="topbar">Ohbox</div></body></html>`);
      return await page.evaluate(() => {
        const note = document.querySelector(".acct-note")!;
        const row = note.querySelector(".acct-note-row")!;
        const said = row.querySelector("span")!;
        const box = (el: Element) => { const r = el.getBoundingClientRect(); return { mid: r.top + r.height / 2, height: r.height, right: r.right }; };
        const lineHeight = parseFloat(getComputedStyle(note).lineHeight) || parseFloat(getComputedStyle(note).fontSize) * 1.55;
        return { note: box(note), lineHeight, buttons: [...row.querySelectorAll("button")].map(box), cut: said.scrollWidth > said.clientWidth + 1 };
      });
    } finally {
      await page.close();
    }
  };

  for (const locale of ["en", "de"] as const) {
    it(`is one row, one line high, from 390 to 1440 px (${locale})`, { timeout: 90_000 }, async () => {
      listed = four();
      await read();
      await mount(locale);
      const html = host.innerHTML;
      expect(html).toContain("acct-note");
      await pressDetails();
      const opened = host.innerHTML;
      for (const face of ["", "ohmarchy"]) {
        for (const width of [390, 560, 1024, 1440]) {
          const at = `${locale} ${face || "paper"} ${width}`;
          const boxes = await lay(html, width, face);
          expect(boxes.buttons, `${at}: Details and OK`).toHaveLength(2);
          for (const b of boxes.buttons) {
            expect(Math.abs(b.mid - boxes.note.mid), `${at}: a button off the row`).toBeLessThanOrEqual(3);
            expect(b.right, `${at}: a button past the window`).toBeLessThanOrEqual(width);
          }
          expect(boxes.note.height, `${at}: the notice is ${boxes.note.height}px high`).toBeLessThanOrEqual(boxes.lineHeight + 16);
          const open = await lay(opened, width, face);
          expect(open.cut, `${at}: the sentence is cut short with Details open`).toBe(false);
        }
      }
    });
  }
});
