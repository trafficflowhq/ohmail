import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Subject } from "../subject.js";
import { doorSubjects } from "../../../packages/app/test/states/doors-open.js";

/** The doors' page on the screen `authorize`: each registered state it draws, and the screen's seven looks. */
const registered = JSON.parse(readFileSync(resolve(process.cwd(), "test/compare/registry.json"), "utf8")) as {
  states: { key: string; screen: string }[];
};

export const subjects: Subject[] = doorSubjects("authorize", registered.states);
