import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readerStatesPage } from "../../../packages/app/test/states/reader-states.mjs";
import { readAddress, whole } from "./screener-address-measure";

/* The Screener's Waiting row on a phone, on an account with two mailboxes: the row names the mailbox a letter came to
   with a short chip. Short of room the chip is readable or not there: never a stub of a letter or two, never over the
   time; with room for most of it, it stands cut short with an ellipsis. */
const origin = "https://screener-chip.states.invalid";
let browser: Browser;
let html: string;

beforeAll(async () => {
  html = await readerStatesPage("apps/webapp/test/phone-width-screener-page.tsx");
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

const row = (page: Page) => page.getByRole("option", { name: "Casey Sender: The Screener's test letter" });
const badge = (page: Page) => row(page).locator(".sc-mailbox-badge");

async function visit(width: number, check: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: true });
  try {
    await page.route("**/*", (route) =>
      route.request().url() === `${origin}/`
        ? route.fulfill({ contentType: "text/html", body: html })
        : route.abort(),
    );
    await page.addInitScript("window.process = { env: {} };");
    await page.goto(origin);
    await badge(page).waitFor({ timeout: 5000 });
    await check(page);
  } finally {
    await page.close();
  }
}

describe("the mailbox chip on a Screener row on a phone", () => {
  it.each([360, 404])(
    "at %i wide beside a long sender domain is readable or gone, never over the time",
    async (width) => {
      await visit(width, async (page) => {
        await row(page)
          .locator(".oh-address-domain")
          .first()
          .evaluate((domain) => {
            domain.textContent = "@accounts.receivables-department.example";
          });
        const read = await row(page).evaluate((option) => {
          const tag = option.querySelector<HTMLElement>(".sc-mailbox-badge > *")!;
          const time = option.querySelector<HTMLElement>("time")!.getBoundingClientRect();
          /* What of the chip is painted: its box inside every box around it that clips. */
          let painted = tag.getBoundingClientRect();
          for (let node = tag.parentElement; node && node !== option; node = node.parentElement) {
            if (getComputedStyle(node).overflowX === "visible") continue;
            const clip = node.getBoundingClientRect();
            const left = Math.max(painted.left, clip.left);
            const right = Math.min(painted.right, clip.right);
            const top = Math.max(painted.top, clip.top);
            const bottom = Math.min(painted.bottom, clip.bottom);
            painted = new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
          }
          const probe = document.createElement("span");
          probe.style.cssText = "position:absolute;visibility:hidden";
          probe.textContent = "000000";
          tag.append(probe);
          const six = probe.getBoundingClientRect().width;
          probe.remove();
          const seen = painted.width > 0 && painted.height > 0 ? painted.width : 0;
          return { seen, six, overTime: seen > 0 && painted.right > time.left + 0.5 };
        });
        expect(read.overTime, "the chip paints over the time").toBe(false);
        if (read.seen > 0) expect(read.seen, "a stub of the chip stands").toBeGreaterThanOrEqual(read.six - 1);
      });
    },
    30_000,
  );

  it("at 412 wide, with room for most of it, stands cut short with an ellipsis rather than leaving", async () => {
    await visit(412, async (page) => {
      const read = await badge(page).evaluate((node) => {
        const tag = node.querySelector<HTMLElement>(":scope > *")!;
        const box = node.getBoundingClientRect();
        const own = tag.getBoundingClientRect();
        const inside = own.top >= box.top - 0.5 && own.bottom <= box.bottom + 0.5 && own.width > 0;
        return { inside, cut: tag.scrollWidth > tag.clientWidth };
      });
      expect(read).toEqual({ inside: true, cut: true });
    });
  }, 30_000);
});

/** What of the sender's name a person sees on line one, two characters' width in its type, and the local part's. */
const readName = (): { seen: number; twoCh: number; local: number } => {
  const line = document.querySelector<HTMLElement>("[role=option] .oh-row-first")!;
  const who = line.querySelector<HTMLElement>(".oh-row-who")!;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  probe.textContent = "00";
  who.append(probe);
  const twoCh = probe.getBoundingClientRect().width;
  probe.remove();
  let [left, right, top, bottom] = [-Infinity, Infinity, -Infinity, Infinity];
  for (let node: Element | null = who; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    if (style.overflowX !== "visible") [left, right] = [Math.max(left, box.left), Math.min(right, box.right)];
    if (style.overflowY !== "visible") [top, bottom] = [Math.max(top, box.top), Math.min(bottom, box.bottom)];
  }
  const range = document.createRange();
  range.selectNodeContents(who);
  let seen = 0;
  for (const rect of range.getClientRects()) {
    if (Math.min(rect.bottom, bottom) <= Math.max(rect.top, top)) continue;
    seen = Math.max(seen, Math.min(rect.right, right) - Math.max(rect.left, left));
  }
  const local = line.querySelector<HTMLElement>(".oh-row-address .oh-address-local")!.getBoundingClientRect();
  return { seen: Math.max(0, seen), twoCh, local: local.width };
};

/* A named sender on the Screener's row on a phone: the address's local part gives way before its domain breaks, the
   domain is painted whole inside the row, and the name is readable (two characters at the least) or not there. 300
   to 312 are the widths of everyday phones; up to 378 the name has only a little room beside the address. */
describe("a named sender on a Screener row on a phone", () => {
  const senders = ["Anna Keller", "Harbourline Freight", "Cinderlock Security"];
  const addresses = [
    ["keller", "northfield-ag.example"],
    ["invoices", "harbourline-co.example"],
    ["billing", "cinderl0ck-secure.example"],
  ] as const;
  for (const width of [300, 306, 312, 330, 342, 354, 366, 378])
    for (const name of senders)
      for (const [local, domain] of addresses) {
        const length = local.length + 1 + domain.length;
        it(`${name}, a ${length}-character address, ${width} wide: the domain whole, the name readable or gone`, async () => {
          await visit(width, async (page) => {
            await row(page).evaluate(
              (option, [name, local, domain]) => {
                const who = option.querySelector<HTMLElement>(".oh-row-who")!;
                const holder = who.querySelector<HTMLElement>("button, a") ?? who.querySelector<HTMLElement>(".oh-row-who-words");
                (holder ?? who).textContent = name;
                option.querySelector<HTMLElement>(".oh-row-address .oh-address-local")!.textContent = local;
                option.querySelector<HTMLElement>(".oh-row-address .oh-address-domain")!.textContent = `@${domain}`;
              },
              [name, local, domain] as const,
            );
            const address = await page.evaluate(readAddress, "[role=option] .oh-row-first .oh-row-address");
            whole(address, `${width} wide`);
            const read = await page.evaluate(readName);
            if (address.domainLines > 1)
              expect(read.local, "the domain broke while the local part kept room").toBeLessThan(1);
            if (read.seen > 0.5)
              expect(read.seen, "a sliver of the name is left on the line").toBeGreaterThanOrEqual(read.twoCh - 0.5);
          });
        }, 30_000);
      }
});
