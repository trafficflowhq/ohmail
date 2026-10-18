/** @vitest-environment jsdom */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * A CANCELLED CEREMONY PERFORMS NOTHING.
 *
 * The erase was attached to a promise's resolution instead of to the ceremony's state: press
 * "Verify and erase", change your mind, press Cancel, and when the verify response landed the
 * account was erased — irreversibly, after the person had said no. The erase is now parked behind
 * `StepUpPrompt`, and the invariant is the same: the parked act runs only if the ceremony is still
 * CURRENT when the factor lands, at the one door both factor paths pass through.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The stubbed doors, shared with the hoisted module factory. `verify` is a promise the TEST
 * resolves on command — the whole defect lives in the window between the press and the
 * response, so a stub that resolves by itself cannot hold that window open.
 */
const rig = vi.hoisted(() => ({
  calls: [] as string[],
  webauthn: false,
  methods: ["totp"] as string[],
  accountId: "acct-under-test",
  settle: null as null | ((v: unknown) => void),
  verifying: null as null | Promise<unknown>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

vi.mock("../app/sign-out", () => ({
  forgetThisBrowser: async () => ({ remaining: [], inventoryComplete: true }),
  signOut: async () => ({ cleared: true, inventoryComplete: true, serverRefused: null, remaining: [] }),
}));

vi.mock("../app/api-client", () => {
  class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  const held = (name: string): Promise<unknown> => {
    rig.calls.push(name);
    const p = new Promise<unknown>((resolve) => {
      rig.settle = resolve;
    });
    rig.verifying = p;
    return p;
  };
  // The access feed as the real client keeps it: every answer published, whoever asked for it.
  let feed: { owner: null; answer: unknown; caughtUp: null; at: number } | null = null;
  const listeners = new Set<() => void>();
  const publish = (answer: unknown) => {
    feed = { owner: null, answer, caughtUp: null, at: Date.now() };
    for (const l of [...listeners]) l();
    return answer;
  };
  return {
    ApiError,
    apiConfigured: () => true,
    accessFeedFor: () => feed,
    onAccessFeed: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    webauthnAvailable: () => rig.webauthn,
    assertPasskey: async () => ({ id: "credential" }),
    codeOf: (e: unknown) => (e as { code?: string }).code ?? null,
    messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
    auth: {
      session: async () => ({
        user: {
          accountId: rig.accountId, email: "person@example.test",
          twofaEnrolled: { webauthn: rig.methods.includes("webauthn"), totp: rig.methods.includes("totp") },
        },
        scope: "full",
      }),
      login: async () => { rig.calls.push("login"); return { status: "twofa_required", loginToken: "tok", methods: rig.methods }; },
      recoveryVerify: () => held("recoveryVerify"),
      stepUpTotp: () => held("stepUpTotp"),
      stepUpWebauthnOptions: async () => ({ options: {} }),
      stepUpWebauthnVerify: () => held("stepUpWebauthnVerify"),
    },
    account: {
      access: async () => publish({ metered: false }),
      /* The first press meets a closed step-up window, as it nearly always does. */
      erase: async () => {
        if (!rig.calls.includes("account.erase:refused")) {
          rig.calls.push("account.erase:refused");
          throw new ApiError(403, "step_up_required", "recent two-factor authentication required");
        }
        rig.calls.push("account.erase");
        return { erased: true, retained: "the accounts row", subscription: "none" };
      },
    },
  };
});

let roots: Root[] = [];

beforeEach(() => {
  rig.calls = [];
  rig.webauthn = false;
  rig.methods = ["totp"];
  rig.settle = null;
  rig.verifying = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function submit(form: Element): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** Mount the pane, press Delete, and stop at the prompt a closed window opens — where the defect lives. */
async function toTheFactorStep(): Promise<HTMLElement> {
  const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages: en,
        timeZone: "UTC",
        now: new Date("2026-09-14T09:00:00.000Z"),
        children: h(AccountSection),
      }),
    );
  });

  await waitFor(() => container.querySelector("#acct-typed") != null, "the facts step");
  await type(container.querySelector<HTMLInputElement>("#acct-typed")!, "person@example.test");
  await submit(container.querySelector("form.acct-confirm")!);

  await waitFor(
    () => container.querySelector('[data-testid="step-up-prompt"]') != null,
    "the step-up prompt",
  );
  expect(rig.calls, "the press tried the erase before asking for a factor").toContain("account.erase:refused");
  return container;
}

/** The prompt's Cancel — by its own label, never by position. */
function cancelControl(container: HTMLElement): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .filter((b) => b.textContent?.trim() === en.devices.cancel);
  expect(found, "exactly one Cancel control at the prompt").toHaveLength(1);
  return found[0]!;
}

/** Press whichever control this arm verifies with, leaving the verify response in flight. */
async function pressVerify(container: HTMLElement, arm: "webauthn" | "totp"): Promise<void> {
  if (arm === "webauthn") {
    await waitFor(
      () => [...container.querySelectorAll("button")].some((b) => b.textContent?.trim() === en.devices.stepUpPasskey),
      "the passkey control",
    );
    const button = [...container.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === en.devices.stepUpPasskey)!;
    await click(button);
  } else {
    await waitFor(() => container.querySelector("#stepup-code") != null, "the code field");
    await type(container.querySelector<HTMLInputElement>("#stepup-code")!, "123456");
    await submit(container.querySelector("#stepup-code")!.closest("form")!);
  }
  await waitFor(() => rig.settle != null, `the ${arm} verify to be in flight`);
}

/** Let the verify response land, the way it lands in a browser: after the press. */
async function landTheVerify(): Promise<void> {
  const settle = rig.settle!;
  await act(async () => {
    settle({ ok: true });
    await rig.verifying;
    await new Promise((r) => setTimeout(r, 15));
  });
}

const ARMS: { name: string; arm: "webauthn" | "totp"; methods: string[]; webauthn: boolean }[] = [
  { name: "the code path (TOTP)", arm: "totp", methods: ["totp"], webauthn: false },
  { name: "the passkey path", arm: "webauthn", methods: ["webauthn"], webauthn: true },
];

describe("Cancel during the verify cancels the erase", () => {
  /**
   * CONTROLS 1 and 3. Control 1 is the code path, the one the finding was written against;
   * control 3 is the passkey path beside it, because they are different code and a fix to one is
   * half-applied by construction. The recovery-code arm is gone: step-up accepts no recovery code.
   */
  for (const { name, arm, methods, webauthn } of ARMS) {
    it(`${name}: Cancel, then the verify lands — no erase call, and the pane says nothing was erased`, async () => {
      rig.methods = methods;
      rig.webauthn = webauthn;
      const container = await toTheFactorStep();

      await pressVerify(container, arm);
      expect(rig.calls, "the verify is in flight and nothing has been erased yet")
        .not.toContain("account.erase");

      await click(cancelControl(container));
      await landTheVerify();

      expect(
        rig.calls,
        "the person pressed Cancel before the check finished: DELETE /account must never be sent",
      ).not.toContain("account.erase");
      expect(container.textContent, "and the pane must SAY nothing was erased")
        .toContain(en.account.cancelledNothingErased);
      expect(container.textContent, "the erasure receipt must not be shown either")
        .not.toContain(en.account.doneTitle);
    }, 20000);
  }

  /** The third path the sign-in shape had, and the prompt does not: a recovery code proves nothing to step-up. */
  it("the prompt offers no recovery code, and nothing at the erase can verify one", async () => {
    rig.methods = ["totp"];
    const container = await toTheFactorStep();
    const promptText = container.querySelector('[data-testid="step-up-prompt"]')!.textContent ?? "";
    expect(promptText, "a recovery-code door at a prompt that cannot take one").not.toMatch(/recovery/i);
    expect(rig.calls, "the erase signed in to confirm").not.toContain("login");
    expect(rig.calls).not.toContain("recoveryVerify");
  }, 20000);

  /** CONTROL 2 — the positive control. This is the feature; a gate that refuses it is no fix. */
  it("an UNCANCELLED ceremony still erases, and shows the receipt", async () => {
    const container = await toTheFactorStep();
    await pressVerify(container, "totp");
    await landTheVerify();

    await waitFor(() => rig.calls.includes("account.erase"), "the erase call");
    expect(rig.calls, "an uncancelled ceremony erases — this is the control").toContain("account.erase");
    await waitFor(
      () => container.textContent!.includes(en.account.doneTitle),
      "the erasure receipt",
    );
    expect(container.textContent, "and it does not claim a cancellation that did not happen")
      .not.toContain(en.account.cancelledNothingErased);
  }, 20000);

  /**
   * CONTROL 4 — the sentence is RENDERED. A state variable nobody paints and a comment
   * explaining the discard are both a person who does not know whether their account exists.
   */
  it("the sentence is the catalogue's own string, rendered, in English and German", async () => {
    const enText = (en.account as Record<string, string>).cancelledNothingErased;
    const deText = (de.account as Record<string, string>).cancelledNothingErased;
    expect(enText, "en.json carries the sentence").toBeTruthy();
    expect(deText, "de.json carries the sentence as RAW TEXT").toBeTruthy();
    expect(deText, "the German is translated, not the English copied").not.toBe(enText);
    expect(deText, "raw text, never an escaped code point").not.toMatch(/\\u[0-9a-fA-F]{4}/);

    const container = await toTheFactorStep();
    await pressVerify(container, "totp");
    await click(cancelControl(container));
    await landTheVerify();

    const paragraph = [...container.querySelectorAll("p")]
      .find((p) => p.textContent?.trim() === enText);
    expect(paragraph, "the sentence is a rendered paragraph of the pane").toBeTruthy();
    expect(paragraph!.getAttribute("role"), "and it is announced").toBe("status");
  }, 20000);
});

// ── The census: every post-verify act in `apps/webapp/app`, and how each is gated ──────────

/**
 * `import.meta.url` is an http URL under jsdom, so the census reads its root from the run's cwd —
 * the repo root, which is where vitest is run from here — and REFUSES by name rather than
 * censusing an empty set if it is not. A census that cannot find its corpus covers nothing.
 */
const APP = `${process.cwd()}/apps/webapp/app`;

/**
 * The SEAM every one of these ceremonies passes through: an awaited second-factor verify. What
 * follows it in the same block is the act the factor authorised, and the question this census
 * asks of each site is what stops that act when the person walks away from the ceremony.
 */
const VERIFY =
  /\bawait\s+auth\.(webauthnAssertVerify|totpVerify|recoveryVerify|stepUpWebauthnVerify|stepUpTotp)\s*\(/g;

interface Site { file: string; verify: string; line: number }

/** Every awaited verify with at least one call after it inside the same block. */
export function postVerifySites(src: string, file: string): Site[] {
  const code = withoutCommentsAndLiterals(src);
  const out: Site[] = [];
  for (const m of code.matchAll(VERIFY)) {
    const from = m.index! + m[0].length;
    // Forward to the end of the ENCLOSING block: the first `}` that closes past our depth.
    let depth = 0;
    let end = code.length;
    for (let i = from; i < code.length; i++) {
      const c = code[i];
      if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "}") {
        if (depth === 0) { end = i; break; }
        depth--;
      }
    }
    const after = code.slice(from, end);
    // A call expression after the verify is the act the factor authorised.
    if (!/[A-Za-z_$][\w$]*\s*\(/.test(after.replace(/^[^;]*;/, ""))) continue;
    out.push({
      file,
      verify: m[1]!,
      line: code.slice(0, m.index!).split("\n").length,
    });
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = `${dir}/${name}`;
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(name)) out.push(abs);
  }
  return out;
}

/**
 * The classification, written by hand because no scanner can read what an act costs. `generation`
 * is the shared gate; `reversible` and `unmount` were the two classifications the erase lane left
 * OPEN as rows, and they are gone because all three took the gate — the spellings stay so a new
 * site can still be pinned as something other than gated, which is what makes the pin a question.
 */
/*
 * The pin FELL from five to two: the erase, the mailbox writes and the desktop link verify no factor
 * of their own any more — each parks its write behind `StepUpPrompt`, the one generation-gated site.
 */
const PINNED: Record<string, { gate: "generation" | "unmount" | "reversible" | "the login itself"; act: string }> = {
  "(product)/mailbox/StepUpPrompt.tsx": { gate: "generation", act: "runs the verb its host parked: an erase, a mailbox write, a desktop link, a device verb" },
  "(product)/login/LoginScreen.tsx": { gate: "the login itself", act: "signs in" },
};

/** Where the mechanism lives: one hook, and the prompt every confirm parks behind calls it. */
const HOOK = `${APP}/(product)/ceremony-generation.ts`;

describe("The census of post-verify acts in apps/webapp/app", () => {
  /**
   * CONTROL 5. A scanner is only as good as a subject that HAS the property: this drives it over
   * a fixture that is exactly the defect, and over one that is not, because a census that counts
   * everything and a census that counts nothing read the same at a call site.
   */
  it("counts a bare post-verify destructive call, and does not count a verify with nothing after it", () => {
    const bare = `
      const finish = async () => {
        await auth.totpVerify({ loginToken: token, code });
        await account.erase();
      };`;
    expect(postVerifySites(bare, "fixture.ts"), "the defect's own shape is COUNTED").toHaveLength(1);

    const nothingAfter = `
      const finish = async () => {
        await auth.totpVerify({ loginToken: token, code });
      };`;
    expect(postVerifySites(nothingAfter, "fixture.ts"), "a verify that authorises nothing is not a site")
      .toHaveLength(0);

    const commented = `
      const finish = async () => {
        // await auth.totpVerify({ loginToken: token, code }); then account.erase()
        return null;
      };`;
    expect(postVerifySites(commented, "fixture.ts"), "a comment is not a call").toHaveLength(0);
  });

  it("every post-verify site in the tree is classified, and no unclassified one appears", () => {
    expect(existsSync(APP), `the census corpus must exist at ${APP} (run vitest from the repo root)`).toBe(true);
    const sites = walk(APP).flatMap((abs) =>
      postVerifySites(readFileSync(abs, "utf8"), abs.slice(APP.length + 1)),
    );
    expect(sites.length, "the census found the ceremonies").toBeGreaterThan(0);
    const unpinned = [...new Set(sites.map((s) => s.file))].filter((f) => !(f in PINNED));
    expect(unpinned, "a NEW post-verify act must be classified here before it ships").toEqual([]);
  });

  it("every post-verify act but the sign-in is gated on the ceremony's generation, and the pin may only FALL", () => {
    const sites = walk(APP).flatMap((abs) =>
      postVerifySites(readFileSync(abs, "utf8"), abs.slice(APP.length + 1)),
    );
    const files = [...new Set(sites.map((s) => s.file))].sort();
    expect(files.length, "the pinned remainder may only fall").toBeLessThanOrEqual(
      Object.keys(PINNED).length,
    );
    const ungated = files.filter((f) => PINNED[f]!.gate !== "generation");
    expect(ungated, "the sign-in is the one act that IS the ceremony").toEqual([
      "(product)/login/LoginScreen.tsx",
    ]);

    // ONE mechanism, in one module: the counter, the comparison and the spend live here and
    // nowhere else, so a site that forks it is a site the next reader has to check twice.
    const hook = withoutCommentsAndLiterals(readFileSync(HOOK, "utf8"));
    expect(hook, "the generation lives in a ref").toMatch(/gen\s*=\s*useRef\(\s*0\s*\)/);
    expect(hook, "and the door compares the captured one").toMatch(/captured !== gen\.current/);

    // And every gated site really passes through it, rather than naming it in a comment.
    for (const file of files.filter((f) => PINNED[f]!.gate === "generation")) {
      const src = withoutCommentsAndLiterals(readFileSync(`${APP}/${file}`, "utf8"));
      expect(src, `${file} takes the shared gate`).toMatch(/useCeremonyGeneration\(\)/);
      expect(src, `${file} captures before its first await`).toMatch(/ceremony\.begin\(\)/);
      expect(src, `${file} compares at its one door`).toMatch(/ceremony\.claim\(/);
      expect(src, `${file} ends the ceremony on Cancel`).toMatch(/ceremony\.end\(\)/);
      // Back on the wall and a pane switch press no Cancel: they unmount the prompt.
      expect(src, `${file} ends the ceremony when it unmounts`)
        .toMatch(/use(?:Layout)?Effect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*\{?\s*ceremony\.end\(\)/);
    }
  });
});
