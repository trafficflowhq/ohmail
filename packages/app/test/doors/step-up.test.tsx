/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TextProvider } from "../../src/text/index.js";
import {
  StepUpDialog,
  type StepUpDoor,
  type StepUpFactors,
  type StepUpRefusal,
  type StepUpVerified,
} from "../../src/doors/step-up/index.js";
import en from "../../messages/doors.en.json" with { type: "json" };
import de from "../../messages/doors.de.json" with { type: "json" };

/**
 * THE SECOND FACTOR, ASKED AGAIN, over a fake door: the factor the account has, each refusal said in its own words,
 * and the one answer a place gets. A factor that lands after Cancel, Esc, the scrim or leaving runs nothing: the place
 * hears "discarded", never "verified".
 */
type Words = Record<string, unknown>;
const W = en.stepUp;
const ALL: StepUpFactors = { passkey: true, code: true, recovery: true };
const CODE_ONLY: StepUpFactors = { passkey: false, code: true, recovery: false };

function later<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A door whose factors and verifies answer as the case says: at once, or when the case lets them. */
function fakeDoor(
  read: StepUpFactors | StepUpRefusal | "never",
  answers: (StepUpVerified | Promise<StepUpVerified>)[] = [],
) {
  const verify = vi.fn((_factor: string, _code: string) => {
    const next = answers.shift();
    return next === undefined ? new Promise<StepUpVerified>(() => {}) : Promise.resolve(next);
  });
  const factors = vi.fn(() =>
    read === "never"
      ? new Promise<never>(() => {})
      : "word" in read
        ? Promise.resolve({ ok: false as const, refusal: read })
        : Promise.resolve({ ok: true as const, factors: read }),
  );
  const door: StepUpDoor = { factors, verify };
  return { door, verify, factors };
}

function draw(
  door: StepUpDoor,
  o: { words?: Words; locale?: "en" | "de"; pending?: boolean; line?: string; withOwner?: boolean } = {},
) {
  const hands = {
    onVerified: vi.fn(),
    onCancel: vi.fn(),
    onDiscarded: vi.fn(),
    onOwnerAbsent: vi.fn(),
  };
  const view = render(
    <TextProvider
      locale={o.locale ?? "en"}
      messages={(o.words ?? en) as never}
      timeZone="UTC"
      pending={o.pending}
    >
      <StepUpDialog
        door={door}
        line={o.line}
        onVerified={hands.onVerified}
        onCancel={hands.onCancel}
        onDiscarded={hands.onDiscarded}
        onOwnerAbsent={o.withOwner === false ? undefined : hands.onOwnerAbsent}
      />
    </TextProvider>,
  );
  return { view, ...hands };
}

const stop = (s: string): string => s.replace(/\.$/, "");
const settle = () => act(async () => {});
const dialog = () => screen.getByRole("dialog");

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the step-up dialog: the way it asks", () => {
  it("while the factors are unknown the code field stands, never the passkey button", () => {
    draw(fakeDoor("never").door);
    expect(dialog().textContent).toContain(stop(W.titleCode));
    expect(screen.getByRole("textbox", { name: W.codeLabel })).toBeTruthy();
    expect(screen.queryByRole("button", { name: new RegExp(W.passkey) })).toBeNull();
    expect(screen.queryByRole("button", { name: new RegExp(W.usePasskey) })).toBeNull();
  });

  it("a passkey where this browser can run it, and the other enrolled ways offered instead", async () => {
    draw(fakeDoor(ALL).door);
    await settle();
    expect(dialog().textContent).toContain(stop(W.titlePasskey));
    expect(screen.getByRole("button", { name: new RegExp(W.passkey) })).toBeTruthy();
    expect(screen.getByRole("button", { name: W.useCode })).toBeTruthy();
    expect(screen.getByRole("button", { name: W.useRecovery })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("offers no way the account has not enrolled", async () => {
    draw(fakeDoor(CODE_ONLY).door);
    await settle();
    expect(screen.getByRole("textbox", { name: W.codeLabel })).toBeTruthy();
    for (const way of [W.usePasskey, W.useCode, W.useRecovery])
      expect(screen.queryByRole("button", { name: way })).toBeNull();
  });

  it("says the place's own line, and the door's when the place has none", async () => {
    draw(fakeDoor(CODE_ONLY).door, { line: "The next successful factor erases the account." });
    expect(dialog().textContent).toContain("The next successful factor erases the account.");
    cleanup();
    draw(fakeDoor(CODE_ONLY).door);
    expect(dialog().textContent).toContain(W.door);
  });

  it("a recovery code instead: its own field, and the code sent as typed", async () => {
    const { door, verify } = fakeDoor(ALL, [{ ok: true }]);
    const { onVerified } = draw(door);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: W.useRecovery }));
    expect(dialog().textContent).toContain(stop(W.titleRecovery));
    fireEvent.change(screen.getByRole("textbox", { name: W.recoveryLabel }), {
      target: { value: " abcd-efgh " },
    });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(W.verify) }));
    await settle();
    expect(verify).toHaveBeenCalledWith("recovery", " abcd-efgh ");
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it("as the prompt it replaced: the code opens the number pad and holds ten characters, a recovery code sixty-four", async () => {
    draw(fakeDoor(ALL).door);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: W.useCode }));
    const code = screen.getByRole("textbox", { name: W.codeLabel });
    expect(code.getAttribute("inputmode")).toBe("numeric");
    expect(code.getAttribute("maxlength")).toBe("10");
    fireEvent.click(screen.getByRole("button", { name: W.useRecovery }));
    const recovery = screen.getByRole("textbox", { name: W.recoveryLabel });
    expect(recovery.getAttribute("inputmode")).not.toBe("numeric");
    expect(recovery.getAttribute("maxlength")).toBe("64");
  });
});

describe("the step-up dialog: one answer", () => {
  it("a verified code runs the place's verb once, and Verify waits for something typed", async () => {
    const { door, verify } = fakeDoor(CODE_ONLY, [{ ok: true }]);
    const { onVerified, onCancel, onDiscarded } = draw(door);
    await settle();
    const go = screen.getByRole("button", { name: new RegExp(W.verify) }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: W.codeLabel }), { target: { value: "123456" } });
    fireEvent.submit(screen.getByRole("textbox", { name: W.codeLabel }).closest("form")!);
    fireEvent.click(go);
    await settle();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith("code", "123456");
    expect(onVerified).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onDiscarded).not.toHaveBeenCalled();
  });

  it("a passkey press verifies the passkey", async () => {
    const { door, verify } = fakeDoor(ALL, [{ ok: true }]);
    const { onVerified } = draw(door);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(W.passkey) }));
    await settle();
    expect(verify).toHaveBeenCalledWith("passkey", "");
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it("Cancel while a factor is in flight: nothing runs, and the place hears it was discarded", async () => {
    const landing = later<StepUpVerified>();
    const { door } = fakeDoor(ALL, [landing.promise]);
    const { onVerified, onCancel, onDiscarded } = draw(door);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(W.passkey) }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(W.cancel) }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    landing.resolve({ ok: true });
    await settle();
    expect(onVerified).not.toHaveBeenCalled();
    expect(onDiscarded).toHaveBeenCalledTimes(1);
  });

  it("Esc and the scrim are Cancel", async () => {
    const { onCancel } = draw(fakeDoor(CODE_ONLY).door);
    await settle();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    const scrim = dialog().parentElement!;
    fireEvent.pointerDown(scrim, { target: scrim });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("leaving while a factor is in flight runs nothing either", async () => {
    const landing = later<StepUpVerified>();
    const { door } = fakeDoor(ALL, [landing.promise]);
    const { view, onVerified, onDiscarded } = draw(door);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(W.passkey) }));
    view.unmount();
    landing.resolve({ ok: true });
    await settle();
    expect(onVerified).not.toHaveBeenCalled();
    expect(onDiscarded).toHaveBeenCalledTimes(1);
  });

  it("a second press while one is in flight sends nothing more", async () => {
    const landing = later<StepUpVerified>();
    const { door, verify } = fakeDoor(ALL, [landing.promise, { ok: true }]);
    const { onVerified } = draw(door);
    await settle();
    const go = screen.getByRole("button", { name: new RegExp(W.passkey) });
    fireEvent.click(go);
    fireEvent.click(go);
    landing.resolve({ ok: true });
    await settle();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(onVerified).toHaveBeenCalledTimes(1);
  });
});

describe("the step-up dialog: each refusal in its own words", () => {
  const cases: [StepUpRefusal, string][] = [
    [
      { word: "locked", minutes: 3 },
      W.locked.replace("{minutes, plural, one {# minute} other {# minutes}}", "3 minutes"),
    ],
    [{ word: "bad_code" }, W.badCode],
    [{ word: "bad_passkey" }, W.badPasskey],
    [{ word: "bad_recovery" }, W.badRecovery],
    [{ word: "slowed" }, W.slowed],
    [{ word: "refused" }, W.refused],
    [{ word: "said", said: "The server is busy." }, "The server is busy."],
  ];
  for (const [refusal, sentence] of cases) {
    it(`${refusal.word}: said, the verb not run, and the next press is a new ceremony`, async () => {
      const { door, verify } = fakeDoor(CODE_ONLY, [{ ok: false, refusal }, { ok: true }]);
      const { onVerified, onCancel } = draw(door);
      await settle();
      fireEvent.change(screen.getByRole("textbox", { name: W.codeLabel }), { target: { value: "111111" } });
      fireEvent.click(screen.getByRole("button", { name: new RegExp(W.verify) }));
      await settle();
      expect(dialog().textContent).toContain(sentence);
      expect(onVerified).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
      fireEvent.change(screen.getByRole("textbox", { name: W.codeLabel }), { target: { value: "222222" } });
      fireEvent.click(screen.getByRole("button", { name: new RegExp(W.verify) }));
      await settle();
      expect(verify).toHaveBeenCalledTimes(2);
      expect(onVerified).toHaveBeenCalledTimes(1);
    });
  }

  it("a lock of one minute says one minute", async () => {
    const { door } = fakeDoor(ALL, [{ ok: false, refusal: { word: "locked", minutes: 1 } }]);
    draw(door);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(W.passkey) }));
    await settle();
    expect(dialog().textContent).toContain("in 1 minute.");
    expect(dialog().textContent).not.toContain("1 minutes");
  });

  it("the window's account gone, with a place that settles: the place hears it, the dialog says nothing", async () => {
    const said = "This browser lost track of which account this window is for.";
    const { door } = fakeDoor(CODE_ONLY, [{ ok: false, refusal: { word: "owner_absent", said } }]);
    const { onOwnerAbsent, onVerified } = draw(door);
    await settle();
    fireEvent.change(screen.getByRole("textbox", { name: W.codeLabel }), { target: { value: "111111" } });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(W.verify) }));
    await settle();
    expect(onOwnerAbsent).toHaveBeenCalledTimes(1);
    expect(onVerified).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(said);
  });

  it("the account gone as the factors are read: a place that settles hears it; one that cannot, says it", async () => {
    const said = "This browser lost track of which account this window is for.";
    const first = draw(fakeDoor({ word: "owner_absent", said }).door);
    await settle();
    expect(first.onOwnerAbsent).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(said);
    cleanup();
    draw(fakeDoor({ word: "owner_absent", said }).door, { withOwner: false });
    await settle();
    expect(dialog().textContent).toContain(said);
  });
});

describe("the step-up dialog: its words", () => {
  it("while its words are on their way it waits without a word, and the factors are read", () => {
    const { stepUp: _held, ...cut } = en;
    const { door, factors } = fakeDoor(ALL);
    const { view } = draw(door, { words: cut, pending: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.container.textContent).toBe("");
    expect(view.container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(factors).toHaveBeenCalledTimes(1);
  });

  it("speaks German where the catalogue is German", async () => {
    draw(fakeDoor(ALL).door, { words: de, locale: "de" });
    await settle();
    expect(dialog().textContent).toContain(stop(de.stepUp.titlePasskey));
    expect(screen.getByRole("button", { name: new RegExp(de.stepUp.passkey) })).toBeTruthy();
    expect(screen.getByRole("button", { name: de.stepUp.useCode })).toBeTruthy();
    expect(dialog().textContent).toContain(de.stepUp.door);
  });
});

/**
 * IN A REAL BROWSER, where a control that turns disabled loses the keys: they fall to the document's body, outside the
 * dialog, and Esc is heard by nobody while the factor is on its way. So the dialog's own press keeps its button live
 * (it says it is working and takes no second press), the keys stay inside, and Esc cancels whatever started the check.
 * jsdom moves no focus, so these run in Chromium over `step-up-harness.tsx`, whose door holds each verify by hand.
 */
describe("the step-up dialog in a real browser: Esc while a factor is on its way", () => {
  const REPO = resolve(__dirname, "../../../..");
  const { chromium } = createRequire(join(REPO, "package.json"))(
    "@playwright/test",
  ) as typeof import("@playwright/test");
  type Tab = Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let harness = "";

  beforeAll(async () => {
    harness = execFileSync(process.execPath, [join(REPO, "packages/app/test/doors/step-up-harness.mjs")], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    browser = await chromium.launch();
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  });

  /** The dialog open over the harness, its factors read; `passkey`: the account has one this browser runs. */
  async function opened(passkey = false): Promise<Tab> {
    const tab = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    await tab.route("http://step-up.test/**", (r) => r.fulfill({ contentType: "text/html", body: harness }));
    await tab.goto(`http://step-up.test/${passkey ? "?passkey=1" : ""}`);
    await tab.getByRole("button", { name: W.useRecovery }).waitFor();
    return tab;
  }
  const heard = (tab: Tab) => tab.evaluate(() => ({ ...window.harness.heard }));
  const held = (tab: Tab) => tab.evaluate(() => window.harness.held());
  const keys = (tab: Tab) => tab.evaluate(() => window.harness.keys());
  const land = (tab: Tab, answer: StepUpVerified) => tab.evaluate((a) => window.harness.land(a), answer);
  const verifyButton = (tab: Tab) =>
    tab.getByRole("dialog").getByRole("button", { name: new RegExp(W.verify) });

  /** Esc while the verify is held, then the factor lands: the dialog went at Esc, and the factor ran nothing. */
  async function escapeWhileHeld(tab: Tab): Promise<void> {
    await expect.poll(() => held(tab)).toBe(1);
    expect((await keys(tab)).inside).toBe(true);
    await tab.keyboard.press("Escape");
    await expect.poll(() => tab.getByRole("dialog").count()).toBe(0);
    expect((await heard(tab)).cancelled).toBe(1);
    await land(tab, { ok: true });
    await expect.poll(async () => (await heard(tab)).discarded).toBe(1);
    expect((await heard(tab)).verified).toBe(0);
  }

  it("the dialog's button pressed by the mouse: Esc cancels, and the late factor is discarded", async () => {
    const tab = await opened();
    try {
      await tab.getByRole("textbox", { name: W.codeLabel }).fill("123456");
      await verifyButton(tab).click();
      await escapeWhileHeld(tab);
    } finally {
      await tab.close();
    }
  }, 60_000);

  it("the dialog's button pressed by the keyboard: the same", async () => {
    const tab = await opened();
    try {
      await tab.getByRole("textbox", { name: W.codeLabel }).fill("123456");
      await verifyButton(tab).focus();
      await tab.keyboard.press("Enter");
      await escapeWhileHeld(tab);
    } finally {
      await tab.close();
    }
  }, 60_000);

  it("the passkey, which only its button starts: the same", async () => {
    const tab = await opened(true);
    try {
      await tab
        .getByRole("dialog")
        .getByRole("button", { name: new RegExp(W.passkey) })
        .click();
      await escapeWhileHeld(tab);
    } finally {
      await tab.close();
    }
  }, 60_000);

  it("while it works the button says so and takes no second press", async () => {
    const tab = await opened();
    try {
      await tab.getByRole("textbox", { name: W.codeLabel }).fill("123456");
      await verifyButton(tab).click();
      const working = tab.getByRole("dialog").getByRole("button", { name: new RegExp(W.working) });
      await working.click();
      await tab.keyboard.press("Enter");
      expect(await held(tab)).toBe(1);
      expect((await heard(tab)).sent).toBe(1);
      await land(tab, { ok: true });
      await expect.poll(async () => (await heard(tab)).verified).toBe(1);
    } finally {
      await tab.close();
    }
  }, 60_000);

  /*
   * ONE ESCAPE, ONCE. The kit hears Escape for an open overlay in one place: inside the dialog its box, outside it one
   * listener on the document (the doors add none of their own). So one Escape cancels once wherever the keys are,
   * also where a script has taken them out of the dialog, and a second finds nothing open.
   */
  it.each(["the code's field", "nothing (the keys taken out of the dialog)"] as const)(
    "one Escape with the keys on %s cancels once, and the factor that lands after runs nothing",
    async (where) => {
      const tab = await opened();
      try {
        await tab.getByRole("textbox", { name: W.codeLabel }).fill("123456");
        await verifyButton(tab).click();
        await expect.poll(() => held(tab)).toBe(1);
        if (where === "the code's field") await tab.getByRole("textbox", { name: W.codeLabel }).focus();
        else await tab.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        expect((await keys(tab)).inside).toBe(where === "the code's field");
        await tab.keyboard.press("Escape");
        await expect.poll(() => tab.getByRole("dialog").count()).toBe(0);
        expect((await heard(tab)).cancelled).toBe(1);
        await tab.keyboard.press("Escape");
        expect((await heard(tab)).cancelled).toBe(1);
        await land(tab, { ok: true });
        await expect.poll(async () => (await heard(tab)).discarded).toBe(1);
        expect((await heard(tab)).verified).toBe(0);
      } finally {
        await tab.close();
      }
    },
    60_000,
  );

  it("after a refused code the keys are still inside: Esc closes it, and a second try held then cancelled runs nothing", async () => {
    const tab = await opened();
    try {
      await tab.getByRole("textbox", { name: W.codeLabel }).fill("000000");
      await verifyButton(tab).click();
      await expect.poll(() => held(tab)).toBe(1);
      await land(tab, { ok: false, refusal: { word: "bad_code" } });
      await tab.getByRole("dialog").getByText(W.badCode).waitFor();
      expect((await keys(tab)).inside).toBe(true);
      await verifyButton(tab).click();
      await escapeWhileHeld(tab);
    } finally {
      await tab.close();
    }
  }, 60_000);
});
