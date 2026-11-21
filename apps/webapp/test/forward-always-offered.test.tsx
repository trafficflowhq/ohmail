// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import messages from "../messages/en.json";
import * as scan from "../../../scripts/lib/source-scan.mjs";
import { act, message, stubDom } from "./_draft-shell.js";
import { mountWriting, rounds, unmountWritings } from "./_write-1-writing.js";

const askWords = messages.write.reply.ask;
const source = (rel: string): string => readFileSync(existsSync(rel) ? rel : "../../" + rel, "utf8");

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  stubDom();
});
afterEach(async () => {
  await unmountWritings();
  resetComposerForTest();
});

const askDialog = () => screen.queryByRole("alertdialog", { name: askWords.question });
const forwardBody = () => screen.queryByRole("textbox", { name: messages.write.reply.forwardText });
const press = (button: HTMLElement) => act(async () => { fireEvent.click(button); });

describe("the forward ask stands in the dock until it is answered", () => {
  it("says why the message was flagged and asks once — the editor is not there yet", async () => {
    const flagged = message("m1", {
      sensitivity: { sensitive: true, category: "otp", no_ai: true, no_forward: true, no_kb: true, priority: true },
    });
    const writing = await mountWriting({ messages: [flagged], hash: "#/ohbox", sheet: [flagged.id] });
    const open = async () => {
      await act(async () => { writing.now().openForward(flagged.id); });
      await rounds(6);
    };
    await open();
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(askDialog()?.textContent).toContain(askWords.otp);
    expect(forwardBody()).toBeNull();
    const cancel = within(askDialog()!).getByRole("button", { name: askWords.cancel });
    expect(document.activeElement).toBe(cancel);
    await press(cancel);
    expect(askDialog()).toBeNull();
    expect(forwardBody()).toBeNull();

    await open();
    await press(within(askDialog()!).getByRole("button", { name: askWords.confirm }));
    await rounds(4);
    expect(askDialog()).toBeNull();
    expect(forwardBody()).not.toBeNull();
    expect(writing.sent.filter((entry) => entry.kind === "mail_send")).toEqual([]);
  });

  it("with no ask pending the dock is the forward editor", async () => {
    const letter = message("m1");
    const writing = await mountWriting({ messages: [letter], hash: "#/ohbox", sheet: [letter.id] });
    await act(async () => { writing.now().openForward(letter.id); });
    await rounds(6);
    expect(askDialog()).toBeNull();
    expect(forwardBody()).not.toBeNull();
  });

  it("both catalogues carry every ask sentence", () => {
    const de = JSON.parse(source("apps/webapp/messages/de.json")) as typeof messages;
    const keys = ["otp", "verification", "password_reset", "security_alert", "sensitive", "question", "confirm", "cancel"];
    expect(Object.keys(messages.write.reply.ask).sort()).toEqual([...keys].sort());
    expect(Object.keys(de.write.reply.ask).sort()).toEqual([...keys].sort());
    for (const k of keys) expect((de.write.reply.ask as Record<string, string>)[k]).not.toBe((messages.write.reply.ask as Record<string, string>)[k]);
  });
});

/** Every Forward entry point, and the one predicate each must read. */
const DOORS: Array<[string, RegExp]> = [
  ["packages/app/src/reader/actions/ActionBar.tsx", /id: "forward",[\s\S]*?onPress: \(\) => act\("forward"\)/],
  ["packages/app/src/reader/actions/LetterMenu.tsx", /<MenuItem icon="forward" onPress=\{answers\("forward"\)\}>/],
  ["packages/app/src/reader/actions/use-verbs.ts", /if \(answer !== null && \(action === "reply" \|\| action === "reply_all" \|\| action === "forward"\)\)/],
  [
    "packages/app/src/reader/keys.ts",
    /const resting = open === null \? \(\{ disabled: true[^;]*;[\s\S]*\.\.\.resting,[\s\S]*verb\("shift\+f", ts\("key\.forward"\), act\("forward"\)\)/,
  ],
  ["apps/mobile/src/ui/MessageActions.tsx", /forwardOffered: forwardOffered\(m\)/],
];
const code = (rel: string) => scan.withoutCommentsAndLiterals(source(rel));

describe("census: every Forward door reads the one helper", () => {
  it.each(DOORS)("%s gates Forward on forwardOffered and never on the flag or the mirror", (rel, gate) => {
    const src = code(rel);
    expect(scan.withoutComments(source(rel))).toMatch(gate);
    // The two old gates, anywhere in the door's code: the flag and the mirror's answer.
    expect(src, `${rel} still reads no_forward`).not.toMatch(/no_forward/);
    expect(src, `${rel} still gates on the mirror`).not.toMatch(/mirrorHolds\??\.?\(/);
  });

  it("the press decides in forwardPress — the shell's openForward and the phone's reader model", () => {
    const shell = code("packages/app-logic/src/writing/shell-compose.ts");
    expect(shell).toMatch(/const press = forwardPress\(m, held != null\)/);
    expect(code("apps/mobile/src/state/live.ts")).toMatch(/forwardAsk: forwardPress\(m\)\.ask/);
  });
});
