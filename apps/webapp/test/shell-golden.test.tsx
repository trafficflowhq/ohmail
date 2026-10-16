/** @vitest-environment jsdom */
/**
 * THE SHELL'S RENDERED OUTPUT, PINNED BEFORE IT IS TAKEN APART.
 *
 * `AppShell.tsx` is being split into `shell-*.ts` hooks (ARCH-022). A move that is byte-identical
 * in behaviour renders byte-identical DOM, and no unit test in this directory asks that of the
 * WHOLE shell — each asks about its own seam. This one mounts the demo client once, walks the
 * route list a person can reach, and snapshots the normalised markup per route.
 */
/**
 * Watched fail: one character of a `className` in `AppShell.tsx`'s JSX → red on every route that
 * renders it. `-u` is refused by name in an extraction lane: a snapshot that moved is the finding.
 */
// The snapshots were taken in Europe/Zurich: pin the zone before anything reads a clock.
import "./_tz-zurich.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

// See `selection-pill.test.tsx` for why React is published as a global and `CSS.escape` stubbed.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom implements neither, and the located-row flash calls both from a frame callback.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.scrollTo ??= function scrollTo() {};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/**
 * The routes, in the order they are walked. `__MSG__` is filled from the first Ohbox row rather
 * than written here: the fixture world owns its ids and a literal would pin a fixture edit.
 */
const ROUTES: readonly string[] = [
  "#/ohbox", "#/ohbox/m/__MSG__", "#/reads", "#/receipts", "#/screener/waiting", "#/triage/reply",
  "#/history", "#/search", "#/compose", "#/drafts", "#/trash", "#/settings/general",
  "#/tag/pottery", "#/folder/archive",
];

/**
 * THE TWO THINGS IN THIS MARKUP THAT NO EXTRACTION CAN CHANGE AND NEITHER RUN AGREES ON.
 * `useId` counts from the render tree's position in the process, and `RailNav`'s `Count` carries
 * `tick` for 340 ms of WALL CLOCK after a badge moves — a route walked a third of a second later
 * reads it and one walked sooner does not. Everything else is compared as it is rendered.
 */
const normalise = (html: string): string => html
  .replace(/:r[0-9a-z]+:|_r_[0-9a-z]+_/g, ":rID:")
  .replace(/<span class="tick">/g, "<span>");

let host: HTMLDivElement;
let root: Root;
let painted: Record<string, string> = {};

beforeAll(async () => {
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  window.location.hash = "#/ohbox";
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
      }),
    }));
  });
  await settleFirstPaint();
  const msg = host.querySelector(".view-ohbox .row[data-id]")?.getAttribute("data-id");
  expect(msg, "the Ohbox rendered no row — the walk below would measure nothing").toBeTruthy();
  for (const route of ROUTES) {
    const hash = route.replace("__MSG__", msg!);
    await act(async () => {
      window.location.hash = hash;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settleFirstPaint();
    for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
    painted[route] = normalise(host.innerHTML);
  }
}, 180000);

afterAll(async () => {
  if (root) await act(async () => { root.unmount(); });
  host?.remove();
  painted = {};
  window.location.hash = "";
});

describe("the shell renders the same DOM it rendered before the extraction", () => {
  for (const route of ROUTES) {
    it(`${route} is unchanged`, () => {
      /* A ROUTE THAT FELL TO AN EMPTY FRAME WOULD SNAPSHOT A SMALL BLOB AND PASS FOR EVER. The
         floor and the rail are what every route of the shell renders; a walk that lost the app
         would fail here rather than record its loss as the new golden. */
      expect(painted[route]!.length, `${route} rendered almost nothing`).toBeGreaterThan(3000);
      expect(painted[route], `${route} lost the rail`).toContain("data-rail-id=\"ohbox\"");
      expect(painted[route]).toMatchSnapshot();
    });
  }
});
