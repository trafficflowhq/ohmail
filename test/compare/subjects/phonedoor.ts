import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Subject } from "../subject.js";
import { phoneDoorSubjects } from "../../../packages/app/test/states/phonedoor-open.js";

/**
 * The screen `phonedoor`: the phone's ways in (a server by its address, a computer, the terms and the mailbox on the
 * phone, Confirm, by hand, the copy opening), each registered state the ways in's states page draws, and the screen's
 * looks. The duo's and the book's postures are the phone's own task's.
 */
const registered = JSON.parse(readFileSync(resolve(process.cwd(), "test/compare/registry.json"), "utf8")) as {
  states: { key: string; screen: string }[];
};

export const subjects: Subject[] = phoneDoorSubjects("phonedoor", registered.states);
