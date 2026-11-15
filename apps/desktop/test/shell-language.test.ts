/**
 * THE SHELL'S LANGUAGE, TOLD BY THE WINDOW: `set_shell_language { language }`, answered with one
 * bool — `true` when the shell already speaks it, `false` when the next launch will. No shell, a
 * refusal, or anything else is `refused`, and nothing ever throws to the caller.
 *
 * That each language has the window's catalogue is held on the Rust side (`words_tests.rs` reads
 * both); that the window names only these is held by the type at the call site.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SHELL_LANGUAGES, tellShellLanguage } from "../src/shell-language.js";

type Asked = { command: string; payload?: Record<string, unknown> };
const host = globalThis as { __TAURI_INTERNALS__?: unknown };

function shell(answer: () => unknown): Asked[] {
  const asked: Asked[] = [];
  host.__TAURI_INTERNALS__ = {
    invoke: async (command: string, payload?: Record<string, unknown>) => {
      asked.push({ command, payload });
      return answer();
    },
    transformCallback: () => 0,
  };
  return asked;
}

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

describe("telling the shell its language", () => {
  it("sends the one command with the language and nothing else", async () => {
    const asked = shell(() => false);
    await tellShellLanguage("de");
    expect(asked).toEqual([{ command: "set_shell_language", payload: { language: "de" } }]);
  });

  it("reads true as spoken now and false as from the next launch", async () => {
    shell(() => true);
    expect(await tellShellLanguage("en")).toBe("spoken");
    shell(() => false);
    expect(await tellShellLanguage("de")).toBe("next-launch");
  });

  it("is refused where there is no shell, where the shell refuses, and on any other answer", async () => {
    expect(await tellShellLanguage("de")).toBe("refused");
    shell(() => {
      throw new Error("not a language ohmail speaks");
    });
    expect(await tellShellLanguage("de")).toBe("refused");
    for (const odd of [null, undefined, "true", 1, {}]) {
      shell(() => odd);
      expect(await tellShellLanguage("de"), JSON.stringify(odd)).toBe("refused");
    }
  });

  it("names each language the shell speaks once, as the shell spells it", () => {
    expect([...SHELL_LANGUAGES]).toEqual(["en", "de"]);
  });
});
