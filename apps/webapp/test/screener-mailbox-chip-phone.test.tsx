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
    await row(page).waitFor({ timeout: 5000 });
    await page.evaluate(() => document.fonts.ready);
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
      // Leave enough room for the chip to share the line. The full name is used in the priority case below.
      await row(page).locator(".oh-row-who-words").evaluate((words) => {
        const label = words.querySelector("button, a") ?? words;
        label.textContent = "Casey";
      });
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
  const words = who.querySelector(".oh-row-who-words") ?? who;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  probe.textContent = "00";
  who.append(probe);
  const twoCh = probe.getBoundingClientRect().width;
  probe.remove();
  let [left, right, top, bottom] = [-Infinity, Infinity, -Infinity, Infinity];
  for (let node: Element | null = words; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    if (style.overflowX !== "visible") [left, right] = [Math.max(left, box.left), Math.min(right, box.right)];
    if (style.overflowY !== "visible") [top, bottom] = [Math.max(top, box.top), Math.min(bottom, box.bottom)];
  }
  const range = document.createRange();
  range.selectNodeContents(words);
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

it("at 412 wide the mailbox chip gives way before the sender's name", async () => {
  await visit(412, async (page) => {
    const sender = await page.evaluate(readName);
    expect(sender.seen, "the sender's name is unreadable with the original address").toBeGreaterThanOrEqual(
      sender.twoCh - 0.5,
    );
    for (const length of [12, 14, 16, 18, 20, 22, 24, 26, 28]) {
      await row(page).locator(".oh-address-domain").evaluate((domain, length) => {
        domain.textContent = "@" + "w".repeat(length) + ".invalid";
      }, length);
      const read = await page.evaluate(readName);
      const chipOnLine = await badge(page).evaluate((node) => {
        const chip = node.firstElementChild!.getBoundingClientRect();
        return chip.width > 0 && chip.top < node.getBoundingClientRect().bottom - 0.5;
      });
      expect
        .soft(read.seen > 0.5 || !chipOnLine, `the chip is visible while the name is gone (domain with ${length} wide letters)`)
        .toBe(true);
    }
  });
}, 30_000);

it.each([300, 412])("at %i wide the whole sender domain stays visible when Tab focuses the name", async (width) => {
  await visit(width, async (page) => {
    const option = row(page);
    await option.locator(".oh-address-domain").evaluate((domain) => {
      domain.textContent = "@" + "w".repeat(28) + ".invalid";
    });
    const address = "[role=option] .oh-row-address";
    const before = await page.evaluate(readAddress, address);
    expect(before.domainLines, "the fixture must wrap its domain").toBe(2);
    whole(before, "before Tab");

    await option.focus();
    await page.keyboard.press("Tab");
    const name = option.getByRole("button", { name: "Options for Casey Sender" });
    expect(await name.evaluate((button) => button.matches(":focus-visible"))).toBe(true);
    whole(await page.evaluate(readAddress, address), "with keyboard focus on the sender name");
    const senderFits = await option.evaluate((option) => {
      const sender = option.querySelector(".oh-row-sender")!.getBoundingClientRect();
      const subject = option.querySelector(".oh-row-subject")!.getBoundingClientRect();
      return sender.top >= option.getBoundingClientRect().top - 0.5 && sender.bottom <= subject.top + 0.5;
    });
    expect(senderFits, "the sender stays in the row above the subject").toBe(true);
    const choose = await page.getByRole("button", { name: "Choose a place" }).boundingBox();
    const preview = await option.getByText("snippet of held").boundingBox();
    expect(choose!.y + choose!.height / 2, "the place button stays on the preview line").toBeGreaterThan(preview!.y);
    const ringVisible = await name.evaluate((button) => {
      const style = getComputedStyle(button);
      const stroke = parseFloat(style.outlineWidth);
      const outset = Math.max(0, stroke + parseFloat(style.outlineOffset));
      const bounds = button.getBoundingClientRect();
      if (style.outlineStyle === "none" || stroke <= 0 || !bounds.width || !bounds.height) return false;
      for (let node = button.parentElement; node; node = node.parentElement) {
        const clip = node.getBoundingClientRect();
        const { overflowX, overflowY } = getComputedStyle(node);
        if (overflowX !== "visible" && (bounds.left - outset < clip.left - 0.5 || bounds.right + outset > clip.right + 0.5))
          return false;
        if (overflowY !== "visible" && (bounds.top - outset < clip.top - 0.5 || bounds.bottom + outset > clip.bottom + 0.5))
          return false;
      }
      return true;
    });
    expect(ringVisible, "the focused name and its outline are inside their clipping bounds").toBe(true);
  });
}, 30_000);

describe("the room left for the sender's address on a phone", () => {
  it.each([300, 306, 312, 360, 412])("uses the first line at %i wide", async (width) => {
    await visit(width, async (page) => {
      for (const length of [12, 14, 16, 18, 20, 22, 24, 26, 28]) {
        const address = row(page).locator(".oh-row-address");
        const room = await address.evaluate((node, length) => {
          const domain = node.querySelector<HTMLElement>(".oh-address-domain")!;
          domain.textContent = "@" + "w".repeat(length) + ".invalid";
          const line = node.closest<HTMLElement>(".oh-row-first")!;
          const lineBox = line.getBoundingClientRect();
          const name = line.querySelector<HTMLElement>(".oh-row-who")!;
          const words = name.querySelector(".oh-row-who-words") ?? name;
          const nameBox = words.getBoundingClientRect();
          const nameOnLine = nameBox.width > 0 && nameBox.top < (name.closest(".oh-row-sender") ?? name).getBoundingClientRect().bottom - 0.5;
          const gapProbe = document.createElement("span");
          gapProbe.style.cssText = "position:absolute;visibility:hidden;width:var(--s2)";
          line.append(gapProbe);
          const gap = gapProbe.getBoundingClientRect().width;
          gapProbe.remove();

          // Start with the row, then remove only space taken by visible neighbours and their gaps.
          const start = nameOnLine ? nameBox.right + gap : lineBox.left;
          let end = lineBox.right;
          for (const item of line.querySelectorAll<HTMLElement>(".oh-row-when, .sc-mailbox-badge > *, .oh-row-labels > *")) {
            const box = item.getBoundingClientRect();
            if (box.width > 0 && box.top < item.parentElement!.getBoundingClientRect().bottom - 0.5)
              end = Math.min(end, box.left - gap);
          }
          return { available: end - start, indent: node.getBoundingClientRect().left - lineBox.left, nameOnLine };
        }, length);
        const read = await page.evaluate(readAddress, "[role=option] .oh-row-address");
        whole(read, `${width} wide`);
        if (read.domainW <= room.available + 0.5)
          expect.soft(read.domainLines, "the domain wraps despite room on the first line").toBe(1);
        if (!room.nameOnLine)
          expect.soft(room.indent, "an invisible name leaves an indent before the address").toBeLessThanOrEqual(0.5);
      }
    });
  }, 30_000);
});
