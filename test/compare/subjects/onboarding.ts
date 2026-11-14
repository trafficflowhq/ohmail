import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Subject } from "../subject.js";
import { connectSubjects } from "../../../packages/app/test/states/connect-open.js";

/**
 * The screen `onboarding`: the one connect form's states of a refused connect (`state=c-…`) and the sign-up's mailbox
 * step as the join seats it (`step=provider`), each registered state the connect form's states page draws. The
 * screen's other rows are their own tasks' to add here: the doors' steps, the first run's stage, the phone's postures.
 */
const registered = JSON.parse(readFileSync(resolve(process.cwd(), "test/compare/registry.json"), "utf8")) as {
  states: { key: string; screen: string }[];
};

export const subjects: Subject[] = connectSubjects(registered.states);
