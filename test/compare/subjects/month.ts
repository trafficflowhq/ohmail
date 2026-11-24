import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Subject } from "../subject.js";
import type { Registry } from "../registry.d.mts";
import { openRangePage } from "../../../packages/app/test/states/range-page-open.js";

const registry = JSON.parse(readFileSync(resolve(process.cwd(), "test/compare/registry.json"), "utf8")) as Registry;

/** Every registered state of the screen, drawn by its key on the range views' states page. */
export const subjects: Subject[] = registry.states
  .filter((s) => s.screen === "month")
  .map((s) => ({ key: s.key, open: (p) => openRangePage(p, s.key) }));
