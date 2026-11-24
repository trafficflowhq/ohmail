/**
 * The Ohbox's states, drawn by address through the real frame over the fake host (the Ohbox's states page,
 * `packages/app/test/states/ohbox-page.tsx`): the place's list from the real behaviour hook over the reference's
 * people and letters, and both columns: the page's host hands the reader, which draws the open letter and the list's
 * blank. Each key is the reference's own address, read by the page as it stands.
 */
import { holdTouchState } from "../../../packages/app/test/states/touch-hold.js";
import type { Subject } from "../subject.js";

/** The states this screen builds: the list's own, the default people face, and the named state in its seven links. */
const KEYS = [
  "open=none&screen=ohbox",
  "screen=ohbox&state=clear",
  "screen=ohbox&show=pick",
  "screen=ohbox&show=end",
  "screen=ohbox&show=rowdone",
  "hold=1&open=giulia-glaze&screen=ohbox&show=menu",
  "screen=ohbox&show=pull",
  "people=diag&screen=ohbox",
  "hold=1&open=ben-kiln&screen=ohbox",
  "device=fold&hold=1&open=ben-kiln&screen=ohbox",
  "device=foldl&hold=1&open=ben-kiln&screen=ohbox",
  "face=ohmarchy&hold=1&open=ben-kiln&screen=ohbox",
  "hold=1&open=ben-kiln&scheme=dark&screen=ohbox",
  "face=ohmarchy&hold=1&open=ben-kiln&scheme=dark&screen=ohbox",
  "device=phone&screen=ohbox",
  "device=phone&screen=ohbox&show=swipe-read",
  "device=phone&screen=ohbox&show=swipe-later",
  "device=phone&screen=ohbox&show=pulldown",
];

const ORIGIN = "http://ohbox.states.invalid";
let page: Promise<string> | null = null;

/** The states page as one document, built once a run (its typefaces from the tokens package). */
async function document(): Promise<string> {
  page ??= import("../../../packages/app/test/states/ohbox-states.mjs").then((m: { ohboxStatesPage: () => Promise<string> }) => m.ohboxStatesPage());
  return page;
}

export const subjects: Subject[] = KEYS.map((key) => ({
  key,
  open: async (p) => {
    const html = await document();
    await p.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
    await p.goto(`${ORIGIN}/?${key}`);
    /* The reference's Done stands on Petra's row under the pointer. */
    if (key.includes("show=rowdone")) await p.hover('[role="option"][data-id="petra-talk"]');
    /* A touch state is a finger held down on the phone's list. */
    await holdTouchState(p, key);
  },
}));
