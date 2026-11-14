/**
 * THE SENDER's DOMAIN IS NEVER CUT (an identity surface). The name in a letter's head is the sender's to choose; the
 * address, and above all its domain, is the evidence a stranger is judged by. Whatever the name says and however
 * long the address, the head draws the domain whole: the local part gives way first, and where the name and the
 * address do not fit on one line the address takes the line under the name, and who the letter went to stands
 * under that. Drawn in Chromium with the mail entry's own sheets and faces, a desktop's root and a phone's.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch } from "../../../../test/compare/render.mjs";
import { AddressText } from "../../src/base/index.js";
import { MessageHead } from "../../src/mail/index.js";
import { DEVICES, entryCss, fontsCss, type Device } from "../compare/harness.js";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
let browser: Awaited<ReturnType<typeof launch>> | null = null;
beforeAll(async () => {
  browser = await launch(chromium);
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

/** Sixty characters a sender chose, and invented addresses only. */
const NAME = "Lena Kaufmann of Atelier Eichspan, Customer Care and Billing";
const ADDR = "lena@atelier-eichspan.invalid";
const LONG = "giulia.ferrari.accounts.payable.and.invoicing.department@terracotta-studio.invalid";

/** The names Chromium itself hands a screen reader for the buttons of the parts. */
async function buttonsSaid(parts: ReactNode): Promise<string[]> {
  const tab = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await tab.setContent(`<!doctype html><html lang="en" data-face="paper" data-scheme="light" data-device="desktop" data-touch="0"><head><meta charset="utf-8">
<style>${await fontsCss()}</style><style>${await entryCss("mail")}</style></head>
<body><div class="oh-root"><div style="width:572px">${renderToStaticMarkup(parts)}</div></div></body></html>`);
    const cdp = await tab.context().newCDPSession(tab);
    type Value = { value?: unknown };
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
      nodes: { ignored: boolean; role?: Value; name?: Value }[];
    };
    return nodes
      .filter((n) => !n.ignored && n.role?.value === "button")
      .map((n) => String(n.name?.value ?? ""));
  } finally {
    await tab.close();
  }
}

async function drawn<T>(
  parts: ReactNode,
  width: number,
  device: Device,
  read: (address: string) => T,
  address: string,
): Promise<T> {
  const root = {
    "data-face": "paper",
    "data-scheme": "light",
    ...DEVICES[device].root,
    "data-icons": "1",
    "data-rm": "1",
  };
  const attrs = Object.entries(root)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  const [w, h] = DEVICES[device].window;
  const tab = await browser!.newPage({ viewport: { width: w, height: h } });
  try {
    await tab.setContent(`<!doctype html><html lang="en"${attrs}><head><meta charset="utf-8">
<style>${await fontsCss()}</style><style>${await entryCss("mail")}</style><style>html,body{margin:0}</style></head>
<body><div class="oh-root"><div style="width:${width}px">${renderToStaticMarkup(parts)}</div></div></body></html>`);
    await tab.evaluate(() => document.fonts.ready);
    return (await tab.evaluate(read, address)) as T;
  } finally {
    await tab.close();
  }
}

interface Seen {
  /** The domain's width as laid out, and as painted inside every box that clips it. */
  domain: number;
  domainSeen: number;
  /** The local part's lines. */
  localLines: number;
  /** Every painted piece of the address stands inside the control that holds it. */
  inside: boolean;
  /** Something of the address is cut by its own box (an ellipsis or a clip). */
  cut: boolean;
  /** The name's width, in its own ems. */
  nameEm: number;
  /** The recipients' line starts under the address's last line (or there is none). */
  toUnder: boolean;
}

/** The address as a person sees it: its text found by its words, its rects cut to every clip above them. */
const seen = (address: string): Seen => {
  const deepest = (text: string): HTMLElement | null => {
    let best: HTMLElement | null = null;
    for (const el of document.querySelectorAll<HTMLElement>("body *")) if (el.textContent === text) best = el;
    return best;
  };
  const host = deepest(address)!;
  const control = host.closest("button") ?? host.parentElement!;
  const at = address.lastIndexOf("@");
  const clip = (el: Element) => {
    let L = -Infinity,
      R = Infinity,
      T = -Infinity,
      B = Infinity;
    for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
      const c = getComputedStyle(a),
        r = a.getBoundingClientRect();
      if (c.overflowX !== "visible") {
        L = Math.max(L, r.left);
        R = Math.min(R, r.right);
      }
      if (c.overflowY !== "visible") {
        T = Math.max(T, r.top);
        B = Math.min(B, r.bottom);
      }
    }
    return { L, R, T, B };
  };
  const nodes: { n: Text; start: number }[] = [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let off = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push({ n, start: off });
    off += n.data.length;
  }
  const box = control.getBoundingClientRect();
  let inside = true;
  let bottom = -Infinity;
  const measure = (from: number, to: number, clipped: boolean) => {
    const lines = new Map<number, [number, number][]>();
    for (const { n, start } of nodes) {
      const a = Math.max(from, start),
        b = Math.min(to, start + n.data.length);
      if (a >= b) continue;
      const range = document.createRange();
      range.setStart(n, a - start);
      range.setEnd(n, b - start);
      const k = clip(n.parentElement!);
      for (const r of range.getClientRects()) {
        let [l, rr] = [r.left, r.right];
        if (clipped) {
          if (Math.min(r.bottom, k.B) <= Math.max(r.top, k.T)) continue;
          [l, rr] = [Math.max(l, k.L), Math.min(rr, k.R)];
          if (rr > l && (l < box.left - 0.5 || rr > box.right + 0.5 || r.bottom > box.bottom + 0.5))
            inside = false;
          if (rr > l) bottom = Math.max(bottom, r.bottom);
        }
        if (rr > l) lines.set(Math.round(r.top), [...(lines.get(Math.round(r.top)) ?? []), [l, rr]]);
      }
    }
    let w = 0;
    for (const spans of lines.values()) {
      spans.sort((x, y) => x[0] - y[0]);
      let [cl, cr] = spans[0]!;
      for (const [l, r] of spans.slice(1)) {
        if (l <= cr) cr = Math.max(cr, r);
        else {
          w += cr - cl;
          [cl, cr] = [l, r];
        }
      }
      w += cr - cl;
    }
    return { w, lines: lines.size };
  };
  const domain = measure(at, address.length, false).w;
  const domainSeen = measure(at, address.length, true).w;
  measure(0, address.length, true);
  const localLines = at > 0 ? measure(0, at, true).lines : 0;
  const cut = [host, ...host.querySelectorAll<HTMLElement>("*")].some(
    (e) => e.scrollWidth > e.clientWidth + 0.5,
  );
  const name =
    [...document.querySelectorAll<HTMLElement>("b")].find((b) => b.closest("button") === control) ?? null;
  const to =
    [...document.querySelectorAll<HTMLElement>("p")].find((p) => (p.textContent ?? "").startsWith("to ")) ??
    null;
  return {
    domain,
    domainSeen,
    localLines,
    inside,
    cut,
    nameEm: name ? name.clientWidth / parseFloat(getComputedStyle(name).fontSize) : -1,
    toUnder: to ? to.getBoundingClientRect().top >= bottom - 0.5 : true,
  };
};

const head = (name: string, address: string) => (
  <MessageHead
    sender={{ name, address }}
    menu={{ label: "Message" }}
    stamp={{ when: "21 Sep", full: false, title: "Mon 21 Sep 2026 08:40" }}
    to={[{ word: "to", people: [{ name: "you" }] }]}
    details={{ label: "details", open: false, lines: [] }}
  />
);

const whole = (r: Seen, where: string) => {
  expect(r.domain, `${where}: no domain measured`).toBeGreaterThan(0);
  expect(
    r.domainSeen,
    `${where}: the domain is cut (${r.domainSeen} of ${r.domain}px)`,
  ).toBeGreaterThanOrEqual(r.domain - 0.5);
  expect(r.inside, `${where}: the address runs out of the sender's control`).toBe(true);
  expect(r.toUnder, `${where}: who it went to is drawn over the address`).toBe(true);
};

describe("a letter's head draws the sender's domain whole, whatever the name says", () => {
  for (const width of [430, 504, 572]) {
    it(`a ${width}px head, a sixty-character name and a long local part: the domain whole, the name kept to 2.5em at least`, async () => {
      const r = await drawn(head(NAME, LONG), width, "desktop", seen, LONG);
      whole(r, `${width}px`);
      expect(r.nameEm).toBeGreaterThanOrEqual(2.5);
    }, 60_000);
  }

  it("a sixty-character name and an ordinary address: the address is not cut at all, it takes the line under the name", async () => {
    for (const width of [430, 572]) {
      const r = await drawn(head(NAME, ADDR), width, "desktop", seen, ADDR);
      whole(r, `${width}px`);
      expect(r.cut, `${width}px: the address is cut where its own line holds it`).toBe(false);
    }
  }, 60_000);

  it("a short name leaves the address whole beside it", async () => {
    const r = await drawn(head("Bo", ADDR), 572, "desktop", seen, ADDR);
    whole(r, "572px, a two-letter name");
    expect(r.cut).toBe(false);
  }, 60_000);

  for (const width of [240, 300, 360]) {
    it(`a phone's ${width}px head: the domain whole, the local part on one line`, async () => {
      const r = await drawn(head(NAME, LONG), width, "phone", seen, LONG);
      whole(r, `${width}px`);
      expect(r.localLines).toBe(1);
    }, 60_000);
  }
});

describe("the sender, said", () => {
  it("a screen reader hears the name and the address whole, as the head prints them", async () => {
    expect(await buttonsSaid(head(NAME, LONG))).toContain(`${NAME} ${LONG}`);
    expect(
      await buttonsSaid(head("verify@atlas-identity.invalid", "verify@atlas-identity.invalid")),
    ).toContain("verify@atlas-identity.invalid");
  }, 60_000);
});

describe("an address in two halves", () => {
  it("in a box too narrow for it the local part gives way and the domain stands whole", async () => {
    const r = await drawn(<AddressText address={LONG} />, 200, "desktop", seen, LONG);
    expect(r.domainSeen).toBeGreaterThanOrEqual(r.domain - 0.5);
    expect(r.localLines).toBe(1);
  }, 60_000);

  it("with room for it, it is drawn whole and cut nowhere", async () => {
    const r = await drawn(<AddressText address={ADDR} />, 400, "desktop", seen, ADDR);
    expect(r.domainSeen).toBeGreaterThanOrEqual(r.domain - 0.5);
    expect(r.cut).toBe(false);
  }, 60_000);
});
