/**
 * The Ohbox's own states, which no reference draws: an Ohbox with nothing in it, one still loading, an account with
 * no mailbox, and a mailbox nothing organizes yet (the head says so before its action). Drawn on the Ohbox's states
 * page over the fake host, each against the product's own picture in `own/`.
 */
import type { Subject } from "../subject.js";

const ORIGIN = "http://ohbox.states.invalid";
let page: Promise<string> | null = null;

async function document(): Promise<string> {
  page ??= import("../../../packages/app/test/states/ohbox-states.mjs").then((m: { ohboxStatesPage: () => Promise<string> }) => m.ohboxStatesPage());
  return page;
}

export const subjects: Subject[] = (["empty", "loading", "nomailbox", "notorganizing"] as const).map((state) => ({
  key: `own:ohbox-${state}`,
  open: async (p) => {
    const html = await document();
    await p.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
    await p.goto(`${ORIGIN}/?open=none&screen=ohbox&own=${state}`);
  },
}));
