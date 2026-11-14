/** @vitest-environment jsdom */
/**
 * THE ACCOUNT GROUP'S STATES PAGE, BEFORE ANY PICTURE: every registered key the comparison's subjects open is drawn
 * by the page, in Settings, the section's pane in its state; the factor's dialog comes to the state its address names
 * by the steps the subjects walk; and every state of every pane drawn in German says the German catalogue's sentences.
 * The pictures, and German at text size 1.5 in a real browser, are the comparison's run (`account-german.compare.ts`).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_PANES } from "../../src/account/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { TextProvider } from "../../src/text/index.js";
import registry from "../../../../test/compare/registry.json" with { type: "json" };
import { accountFrameHost } from "./account-frame.js";
import {
  ACCOUNT_KEYS,
  ACCOUNT_WORDS,
  accountStatesIn,
  drawnAt,
  factorSteps,
  say,
  slotsFor,
  type Drawn,
  type Lang,
} from "./account-states.js";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

/** The page at an address, as `account-page.tsx` draws it, its answers taken in. */
async function page(query: string, lang: Lang = "en") {
  const words = new URLSearchParams(query);
  const drawn = drawnAt(words, lang);
  if (drawn === null) throw new Error(`the page draws no state at ${query}`);
  const look = {
    face: words.get("face") === "ohmarchy" ? "ohmarchy" : "paper",
    scheme: words.get("scheme") === "dark" ? "dark" : "light",
  } as const;
  render(
    <TextProvider locale={lang} messages={ACCOUNT_WORDS[lang]} timeZone="Europe/Zurich">
      <Frame
        host={accountFrameHost(drawn, slotsFor(words, lang), { device: words.get("device"), look, lang })}
      />
    </TextProvider>,
  );
  await act(async () => {});
  return drawn;
}
/** The words a state's pane says drawn alone, its dialog's read taken in. */
async function paneSays(drawn: Drawn, lang: Lang = "en"): Promise<string> {
  const view = render(
    <TextProvider locale={lang} messages={ACCOUNT_WORDS[lang]} timeZone="Europe/Zurich">
      {drawn.draw(slotsFor(new URLSearchParams(drawn.address ?? ""), lang))}
    </TextProvider>,
  );
  await act(async () => {});
  const said = view.container.textContent ?? "";
  view.unmount();
  return said;
}
const escaped = (words: string) => words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A button by the words its name starts with: a dialog's verbs carry their key after their words. */
const buttonIn = (inside: HTMLElement, words: string) =>
  within(inside).getByRole("button", { name: new RegExp(`^${escaped(words)}`) });

describe("the page draws every key its subjects open", () => {
  const settings = new Set(
    (registry as { states: { key: string; screen: string }[] }).states
      .filter((state) => state.screen === "settings")
      .map((state) => state.key),
  );

  it("each a registered state of Settings, once, and each of the six sections among them", () => {
    expect(ACCOUNT_KEYS.filter((key) => !settings.has(key))).toEqual([]);
    expect(new Set(ACCOUNT_KEYS).size).toBe(ACCOUNT_KEYS.length);
    const sections = new Set(ACCOUNT_KEYS.map((key) => drawnAt(new URLSearchParams(key), "en")?.section));
    expect([...sections].sort()).toEqual([...ACCOUNT_PANES].sort());
  });

  it("each in Settings, its section's pane in the state its key names", async () => {
    for (const key of ACCOUNT_KEYS) {
      const drawn = drawnAt(new URLSearchParams(key), "en")!;
      expect(drawn.address, key).toBe(key);
      const said = await paneSays(drawn);
      await page(key);
      expect(said.length, key).toBeGreaterThan(0);
      expect(document.body.textContent, key).toContain(said);
      cleanup();
    }
  });

  it("the rest state in another look, and a state no picture draws by its name", () => {
    expect(drawnAt(new URLSearchParams("device=fold&screen=settings&sec=devices"), "en")?.id).toBe(
      "devices.rest",
    );
    expect(
      drawnAt(new URLSearchParams("face=ohmarchy&scheme=dark&screen=settings&sec=account"), "en")?.id,
    ).toBe("account.rest");
    // A key whose look is part of the state stays that state.
    expect(
      drawnAt(new URLSearchParams("device=phone&nat=hostsignout&screen=settings&sec=account"), "en")?.id,
    ).toBe("account.aloneAsked");
    expect(drawnAt(new URLSearchParams("pick=security.unread"), "en")?.id).toBe("security.unread");
    expect(drawnAt(new URLSearchParams("screen=settings&sec=nowhere"), "en")).toBeNull();
  });
});

describe("the factor's dialog, brought to its state by a person's steps", () => {
  const asked = ACCOUNT_KEYS.filter((key) => new URLSearchParams(key).get("ask") === "factor");
  const SAID: Readonly<Record<string, [namespace: string, key: string]>> = {
    code: ["stepUp", "badCode"],
    passkey: ["stepUp", "badPasskey"],
    recovery: ["stepUp", "badRecovery"],
    slowed: ["stepUp", "slowed"],
    refused: ["stepUp", "refused"],
    lost: ["session", "refusedOwnerAbsent"],
    pendingout: ["session", "refusedOwnerSignedOut"],
    mismatch: ["session", "refusedOwnerMismatch"],
    unchecked: ["session", "refusedSessionUnchecked"],
  };

  it("walks each address's way and refusal, and the dialog says it", async () => {
    expect(asked.length).toBe(16);
    for (const key of asked) {
      const words = new URLSearchParams(key);
      await page(key);
      for (const step of factorSteps(words)) {
        // The dialog is drawn anew for each way: it is asked for again at every step.
        const dialog = screen.getByRole("dialog");
        await act(async () => {
          if ("press" in step) fireEvent.click(buttonIn(dialog, say("en", "stepUp", step.press)));
          else
            fireEvent.change(within(dialog).getByLabelText(say("en", "stepUp", step.into)), {
              target: { value: step.type },
            });
        });
      }
      const now = screen.getByRole("dialog");
      const how = words.get("how");
      if (how === "code")
        expect(within(now).getByLabelText(say("en", "stepUp", "codeLabel")), key).toBeTruthy();
      if (how === "recovery")
        expect(within(now).getByLabelText(say("en", "stepUp", "recoveryLabel")), key).toBeTruthy();
      if (how === null) expect(buttonIn(now, say("en", "stepUp", "passkey")), key).toBeTruthy();
      const err = words.get("err");
      // The lock says the minutes the server named: the reference's fifteen.
      if (err === "locked") expect(now.textContent, key).toMatch(/\b15\b/);
      else if (err !== null) {
        const [namespace, sentence] = SAID[err]!;
        expect(now.textContent, key).toContain(say("en", namespace, sentence));
      }
      cleanup();
    }
  });
});

describe("every state of every pane, in German", () => {
  /* The sentences of the namespaces the panes read whose German differs: none of them may stand in a German drawing. */
  const NAMESPACES = [
    "account",
    "accountDevices",
    "accountInvites",
    "accountSecurity",
    "accountOwn",
    "accountStorage",
    "accountSubscription",
    "accountLifecycle",
    "devices",
    "invites",
    "security",
    "passwordChange",
    "pairLanding",
    "stepUp",
    "settings",
  ];
  for (const namespace of NAMESPACES)
    if (ACCOUNT_WORDS.en[namespace] === undefined)
      throw new Error(`the page reads no namespace ${namespace}`);
  const english = NAMESPACES.flatMap((namespace) =>
    Object.entries(ACCOUNT_WORDS.en[namespace] as Record<string, unknown>).flatMap(([key, sentence]) => {
      const german = (ACCOUNT_WORDS.de[namespace] as Record<string, unknown> | undefined)?.[key];
      return typeof sentence === "string" &&
        sentence.includes(" ") &&
        !sentence.includes("{") &&
        german !== sentence
        ? [sentence]
        : [];
    }),
  );

  it("says no English sentence of the catalogue where the German one stands, on any pane, in any state", async () => {
    expect(english.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const drawn of accountStatesIn("de")) {
      const said = await paneSays(drawn, "de");
      for (const sentence of english) if (said.includes(sentence)) found.push(`${drawn.id}: ${sentence}`);
    }
    expect(found).toEqual([]);
  });

  it("would see one: the same states in English say them", async () => {
    let seen = 0;
    for (const drawn of accountStatesIn("en")) {
      const said = await paneSays(drawn, "en");
      seen += english.filter((sentence) => said.includes(sentence)).length;
    }
    expect(seen).toBeGreaterThan(50);
  });

  it("draws the page's own refusal and amounts in German too", async () => {
    const failed = accountStatesIn("de").find((drawn) => drawn.id === "devices.failed")!;
    expect(await paneSays(failed, "de")).toContain(say("de", "session", "refusedOffline"));
    const near = accountStatesIn("de").find((drawn) => drawn.id === "storage.near")!;
    expect(await paneSays(near, "de")).toContain(
      say("de", "settings", "storagePriceMonth").replace("{price}", "$9"),
    );
  });
});
