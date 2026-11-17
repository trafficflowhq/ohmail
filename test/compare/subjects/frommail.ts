import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Subject } from "../subject.js";
import type { Registry } from "../registry.d.mts";
import { openCalRestPage } from "../../../packages/app/test/states/calrest-page-open.js";

const registry = JSON.parse(readFileSync(resolve(process.cwd(), "test/compare/registry.json"), "utf8")) as Registry;

/** The states this build does not draw, each in its named class (`declared.json` says them once compared). */
const NOT_BUILT: Readonly<Record<string, string>> = {
  "open=sug-lunch&product=cal&screen=frommail": "no offer of a letter's words while cal-link's owed rows stand",
};

/** Every registered state of From mail this build draws, on the calendar's rest states page. */
export const subjects: Subject[] = registry.states
  .filter((s) => s.screen === "frommail" && s.kind !== "also" && !(s.key in NOT_BUILT))
  .map((s) => ({ key: s.key, open: (p) => openCalRestPage(p, s.key) }));
