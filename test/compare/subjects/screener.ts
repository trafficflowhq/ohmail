/**
 * The Screener's states, drawn by address through the real frame over the fake host (the Screener's states page,
 * `packages/app/test/states/screener-page.tsx`): its place with `ScreenerAbove` over a model double that answers what
 * the reference shows. Each key is the reference's own address, read by the page as it stands. A key of the screen
 * that is not here stands in `declared.json` with its reason.
 */
import type { Subject } from "../subject.js";

/** The states this screen builds. */
const KEYS = [
  "open=scr-lena&screen=screener",
  "open=scr-toess&screen=screener",
  "open=scr-jackpot&screen=screener",
  "open=scr-marco&screen=screener",
  "open=scr-cinderl0ck&screen=screener",
  "open=scr-lena&screen=screener&show=slot",
  "open=scr-lena&screen=screener&show=menu",
  "open=scr-paperbird&screen=screener&show=card",
  "open=scr-paperbird&screen=screener&show=more",
  "screen=screener&show=filter",
  "screen=screener&show=suggest",
  "screen=screener&show=allspam",
  "did=1&screen=screener",
  "screen=screener&sec=screened",
  "screen=screener&sec=spam",
  "queue=60&screen=screener",
  "only=news&queue=60&screen=screener",
  "screen=screener&state=clear",
  "screen=screener&state=reader",
  "device=phone&screen=screener",
  "device=fold&open=scr-lena&screen=screener",
  "device=foldl&open=scr-lena&screen=screener",
  "face=ohmarchy&open=scr-lena&screen=screener",
  "open=scr-lena&scheme=dark&screen=screener",
  "face=ohmarchy&open=scr-lena&scheme=dark&screen=screener",
  "open=scr-lena&org=pending&screen=screener",
  "open=scr-lena&org=refused&screen=screener&who=mac",
  "open=scr-lena&org=nobody&screen=screener",
  "queue=60&screen=screener&state=more",
  "queue=60&screen=screener&state=more-loading",
  "queue=60&screen=screener&state=more-failed",
  "open=none&screen=screener&state=importing",
  "open=none&screen=screener&state=listing",
  "oauth=1&screen=screener&state=reader",
  "open=none&screen=screener&state=failed",
  "open=mmf-own&screen=screener&state=failed",
  "open=mmf-giulia&screen=screener&state=failed",
  "how=cloud&open=scr-jackpot&screen=screener&show=unsub",
  "how=computer&open=scr-jackpot&screen=screener&show=unsub",
  "screen=screener&state=held",
  "screen=screener&state=claimed",
  "screen=screener&state=claimed-list",
  "screen=screener&state=claimed&told=claimedasked",
  "screen=screener&state=claimed&told=claimedfailed",
  "screen=screener&sec=junk",
  ...[
    "live",
    "reading",
    "unread",
    "older",
    "empty",
    "away",
    "find-more",
    "find-none",
    "find-server",
    "find-found",
    "find-nothing",
    "find-cut",
    "find-away",
    "find-failed",
  ].map((state) => `screen=screener&sec=junk&state=${state}`),
  ...["letter", "letter-reading", "letter-failed", "moving", "notmoved"].map(
    (state) => `open=spam-0&screen=screener&sec=junk&state=${state}`,
  ),
];

const ORIGIN = "http://screener.states.invalid";
let page: Promise<string> | null = null;

/** The states page as one document, built once a run (its typefaces from the tokens package). */
async function document(): Promise<string> {
  page ??= import("../../../packages/app/test/states/screener-states.mjs").then(
    (m: { screenerStatesPage: () => Promise<string> }) => m.screenerStatesPage(),
  );
  return page;
}

export const subjects: Subject[] = KEYS.map((key) => ({
  key,
  open: async (p) => {
    const html = await document();
    await p.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await p.goto(`${ORIGIN}/?${key}`);
  },
}));
