/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import messages from "../../webapp/messages/en.json";
import { DISTRIBUTIONS, linksOutToBilling, selfUpdates } from "../src/distribution.js";
import type { AccessRefusedFacts } from "../src/bridge-fetch.js";

/**
 * ═══ THE MAC APP STORE BUILD WITHHOLDS TWO SURFACES, AND THE DOWNLOAD PAGE'S KEEPS THEM ═══
 *
 * A store copy is updated by the store and may not send anybody to a page where a subscription is
 * bought (App Review 3.1.1). Both are properties of the ARTIFACT, decided by a literal the bundler
 * folds in — so the questions here are asked of the predicate directly, and then of one real
 * surface rendered both ways, because a predicate nothing calls withholds nothing.
 *
 * Every arm has its control: the `direct` row is what makes the `mas` row evidence rather than a
 * function that returns false for everything.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  if (root) await act(() => { root?.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.resetModules();
  vi.doUnmock("../src/distribution.js");
});

/** Render the lock with the distribution module replaced, and hand back the rendered anchors. */
async function lockAnchors(distribution: string): Promise<string[]> {
  vi.resetModules();
  vi.doMock("../src/distribution.js", () => ({
    DISTRIBUTIONS: ["direct", "mas"],
    DISTRIBUTION: distribution,
    selfUpdates: () => distribution !== "mas",
    linksOutToBilling: () => distribution !== "mas",
  }));
  const { DesktopAccessLock } = await import("../src/DesktopAccessLock.js");
  const facts: AccessRefusedFacts = { reason: "payment_required", manageUrl: "https://example.invalid/billing" };
  /* A FRESH container per render: React refuses a second `createRoot` on one node, and the two
     arms of this file render twice on purpose. */
  if (root) await act(() => { root?.unmount(); });
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host as HTMLDivElement);
  await act(() => {
    root?.render(h(
      NextIntlClientProvider,
      { locale: "en", messages },
      h(DesktopAccessLock, { facts, onSignedOut: () => {} }),
    ));
  });
  return [...(host as HTMLDivElement).querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
}

describe("the distribution decides two surfaces, and nothing else does", () => {
  it("the predicates answer per distribution, and `direct` is the control", () => {
    expect(selfUpdates("direct")).toBe(true);
    expect(linksOutToBilling("direct")).toBe(true);
    expect(selfUpdates("mas")).toBe(false);
    expect(linksOutToBilling("mas")).toBe(false);
    /* Exactly two, so a third added without a decision about these surfaces fails here. */
    expect([...DISTRIBUTIONS]).toEqual(["direct", "mas"]);
  });

  it("the lock keeps its way back on the download build and drops it on the store build", async () => {
    expect(await lockAnchors("direct")).toEqual(["https://example.invalid/billing"]);
    expect(await lockAnchors("mas")).toEqual([]);
  });

  it("the lock still SAYS what happened on the store build — dropping the button is not silence", async () => {
    await lockAnchors("mas");
    const text = (host as HTMLDivElement).textContent ?? "";
    expect(text).toContain(messages.accessLock.kept);
    /* And the other door out is still there: a lock with no way out is a trap. */
    expect(text).toContain(messages.accessLock.signOut);
  });

  it("the two other call sites name the predicate, and a file that does not is named", () => {
    const calls = (rel: string) => [...readFileSync(rel, "utf8").matchAll(/\b(selfUpdates|linksOutToBilling)\s*\(/g)]
      .map((m) => m[1]);
    expect(calls("apps/desktop/src/DesktopAbout.tsx")).toEqual(["selfUpdates"]);
    expect(calls("apps/desktop/src/DesktopGate.tsx")).toEqual(["linksOutToBilling"]);
    expect(calls("apps/desktop/src/DesktopAccessLock.tsx")).toEqual(["linksOutToBilling"]);
    /* THE CONTROL: the reader finds nothing in a file that calls neither, so a call site that
       silently lost its gate reads as an empty list rather than as a pass. */
    expect(calls("apps/desktop/src/DesktopUpdate.tsx")).toEqual([]);
  });

  it("one flag moves BOTH halves, so a window and a shell cannot disagree about the distribution", () => {
    const build = readFileSync("apps/desktop/scripts/build-engine-app.mjs", "utf8");
    /* The window's literal is set from the same variable the cargo feature is appended from. */
    expect(build).toContain("OHMAIL_DISTRIBUTION: distribution");
    expect(build).toContain('["local-engine", ...(distribution === "mas" ? ["mas"] : [])].join(",")');
    /* THE CONTROL: a second `--features` flag is what this replaced, and it must not come back —
       whether a repeated flag appends or replaces is the CLI's business, not an artifact's. */
    expect([...build.matchAll(/"--features"/g)]).toHaveLength(1);
    expect(build).not.toContain("--features mas");
  });

  it("the bundler folds the literal in, and the default is the ordinary app", () => {
    const vite = readFileSync("apps/desktop/vite.config.ts", "utf8");
    expect(vite).toContain("__OHMAIL_DISTRIBUTION__");
    expect(vite).toContain('process.env.OHMAIL_DISTRIBUTION ?? ""');
    expect(vite).toContain('|| "direct"');
  });
});
