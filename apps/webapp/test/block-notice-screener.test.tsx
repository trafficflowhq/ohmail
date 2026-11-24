/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import type { MessageBodyWire } from "@ohmail/wire";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import type { ImageDoor } from "@ohmail/app-logic/reader/remote-images";
import { cloneElement, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COPY } from "../../../packages/letter-body/src/MessageBody";
import { message } from "./_draft-shell.js";
import type { MailShellProps } from "./_mail-shell.js";
import {
  ISO, act, answerConsentWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";

/** The mounted Screener discloses blocked tracking and asks before loading a held letter's pictures. */
/* ── fixtures: a framed document with a beacon, and one with only words ─────────────────────── */

const SENDER = "images.newsletter.example";
const BEACON = `https://${SENDER}/wf/open?upn=abc`;
const canvas = (inner: string) => `<table width="600"><tr><td><p>hello</p>${inner}</td></tr></table>`;
const PIXEL_ONLY = canvas(`<img src="${BEACON}" width="1" height="1">`);
const ONLY_WORDS = canvas("<p>only words</p>");

const PICTURED = canvas(`<img src="https://${SENDER}/hero.png" width="600" height="200">`);

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  answerConsentWith({ blockRemoteImagesAt: null, loadTrackingPixelsAt: null });
});
afterEach(teardownShellEnv);

async function mountScreener(html: string, imageWire?: ImageDoor): Promise<HTMLElement> {
  const held = ["m1", "m2"].map((id) => message(id, {
    accountId: "acct_live_1", mailboxId: "mb_1", folder: "ohmail/Screener", subject: `Subject ${id}`, date: ISO,
    from: { name: "Acme Store", address: "orders@acme.example" },
  }));
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(held.map((entity, i) =>
    ({ type: "message", op: "create", id: entity.id, seq: i + 1, updatedAt: ISO, entity })));
  const engine = new OhmailEngine({
    store,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: ISO,
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" }),
      fetchBody: async (): Promise<MessageBodyWire> => ({
        text: "FULL BODY", html, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  });
  window.location.hash = "#/screener";
  const host = await mountShell([mailbox({
    id: "mb_1", lastSyncAt: ISO, organizerRole: "organizer", organizeConsentedAt: ISO,
  })], {
    engine, junkWire: "none", suggestWire: "none",
    wrap: imageWire ? (shell) => cloneElement(shell as ReactElement<MailShellProps>, { imageWire }) : undefined,
  });
  await tick(50);
  await act(async () => { within(host).getByRole("option", { name: /^Acme Store:/ }).click(); });
  await tick(50);
  return within(host).getByRole("region", { name: "Reading" });
}

const firstLetter = (preview: HTMLElement) =>
  within(preview).getByRole("heading", { name: "Subject m1" }).closest("article")!;

const APP_SRC = resolve(process.cwd(), "packages/app/src");
describe("the census: every host that mounts the viewer passes onNotice", () => {
  it("every host wears the report somewhere in its own chrome: the Screener's held letter", () => {
    const rel = "screener/held/HeldLetter.tsx";
    const src = readFileSync(resolve(APP_SRC, rel), "utf8");
    expect(/BlockedImages|notice=\{notice\}/.test(src), `${rel} takes the report and renders nothing with it`).toBe(true);
  });
});

describe("the Screener's held card", () => {
  it("wears the glyph in its head line, right before the time — and no bar", async () => {
    const el = await mountScreener(PIXEL_ONLY);
    const cards = within(el).getAllByRole("article");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      const glyph = within(card).getByRole("button", { name: COPY.pixelCaption });
      const head = glyph.closest("header");
      expect(head).not.toBeNull();
      const stamp = head!.querySelector("time");
      expect(stamp).not.toBeNull();
      expect(glyph.parentElement?.nextElementSibling?.contains(stamp)).toBe(true);
      expect(stamp?.parentElement?.nextElementSibling).toBeNull();
      expect(within(card).queryByText(COPY.pixelOnly, { exact: true })).toBeNull();
      const describedBy = glyph.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      const tooltip = within(document.body).getAllByRole("tooltip", { hidden: true })
        .find((element) => element.id === describedBy);
      expect(tooltip?.textContent).toBe(COPY.pixelOnly);
    }
  });

  it("a held message with nothing refused wears no glyph", async () => {
    const el = await mountScreener(ONLY_WORDS);
    const cards = within(el).getAllByRole("article");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      for (const name of [COPY.pixelCaption, COPY.imagesCaption, COPY.sheetCaption]) {
        expect(within(card).queryByRole("button", { name })).toBeNull();
      }
    }
  });
});

/** Every proxied picture the frames under `el` name, parked or live. */
function proxiedIn(el: Element): string[] {
  return [...el.querySelectorAll("iframe")].flatMap((f) =>
    [...new DOMParser().parseFromString(f.getAttribute("srcdoc") ?? "", "text/html").querySelectorAll("img")]
      .map((img) => img.getAttribute("data-ohmail-src") ?? img.getAttribute("src") ?? "")
      .filter((src) => src.includes("/api/img")));
}

describe("a sender not let in", () => {
  it("the Screener's held cards name no proxied picture and offer Show images, which asks for that letter", async () => {
    const pressed: string[] = [];
    const el = await mountScreener(PICTURED, {
      address: (id, url) => `${window.location.origin}/api/img?mid=${id}&u=${encodeURIComponent(url)}`,
      record: async (id) => { pressed.push(id); },
    });
    const card = firstLetter(el);
    expect(proxiedIn(el), "a held sender's picture was asked for on open").toEqual([]);
    const show = within(card).getByRole("button", { name: COPY.show });
    await act(async () => { show.click(); });
    await tick(0);
    expect(pressed).toEqual(["m1"]);
  });

  it("on a door that fetches its own pictures, a held card's Show images loads them into the card", async () => {
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const recorded: string[] = [];
    const fetched: string[] = [];
    const el = await mountScreener(PICTURED, {
      fetch: async (id, url) => { fetched.push(`${id} ${url}`); return PNG; },
      record: async (id) => { recorded.push(id); },
    });
    const card = firstLetter(el);
    expect(fetched, "a held sender's picture was fetched on open").toEqual([]);
    const show = within(card).getByRole("button", { name: COPY.show });
    await act(async () => { show.click(); });
    await tick(50);
    expect(recorded).toEqual(["m1"]);
    expect(fetched).toEqual([`m1 https://${SENDER}/hero.png`]);
    const drawn = [...new DOMParser().parseFromString(card.querySelector("iframe")?.getAttribute("srcdoc") ?? "", "text/html")
      .querySelectorAll("img")].filter((img) => img.getAttribute("src") === PNG);
    expect(drawn.length, "the fetched picture never reached the card").toBe(1);
  });
});
