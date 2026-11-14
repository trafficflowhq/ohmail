import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Subject } from "../subject.js";
import { accountSubjects } from "../../../packages/app/test/states/account-open.js";

/**
 * The screen `settings`: the account group's sections (Devices, Subscription, Storage, Invites, Security, Account and
 * the card a window draws in place of three of them), each registered state the account's states page draws. Every
 * other section's rows are their own tasks' to add here.
 */
const registered = JSON.parse(readFileSync(resolve(process.cwd(), "test/compare/registry.json"), "utf8")) as {
  states: { key: string; screen: string }[];
};

export const subjects: Subject[] = accountSubjects(registered.states);
