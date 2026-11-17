import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Subject } from "../subject.js";
import { serversSubjects } from "../../../packages/app/test/states/servers-open.js";

/**
 * The screen `servers`: the phone's list of servers on the door's page, each registered state the list's states page
 * draws (Stop and remove's dialogs among them, opened by its press), and the screen's looks. The duo's and the book's
 * postures are the phone's own task's.
 */
const registered = JSON.parse(readFileSync(resolve(process.cwd(), "test/compare/registry.json"), "utf8")) as {
  states: { key: string; screen: string }[];
};

export const subjects: Subject[] = serversSubjects(registered.states);
