/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import messages from "../../webapp/messages/en.json";
import { DISTRIBUTIONS, isPreview, linksOutToBilling, selfUpdates } from "../src/distribution.js";
import type { AccessRefusedFacts, EngineStatus } from "../src/bridge-fetch.js";
import { buildVariant } from "../scripts/build-variant.mjs";

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
  /* The module is mocked, so its export comes back as `any` and `createElement` has no overload
     to match. Named at the seam rather than suppressed at the call: the component's real props are
     asserted by the objects handed to it, three lines down. */
  const mod = await import("../src/DesktopAccessLock.js") as {
    DesktopAccessLock: (p: { facts: AccessRefusedFacts; onSignedOut: (s: never) => void }) => React.ReactElement;
  };
  const { DesktopAccessLock } = mod;
  const facts: AccessRefusedFacts = { reason: "payment_required", manageUrl: "https://example.invalid/billing" };
  /* A FRESH container per render: React refuses a second `createRoot` on one node, and the two
     arms of this file render twice on purpose. */
  if (root) await act(() => { root?.unmount(); });
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host as HTMLDivElement);
  await act(() => {
    /* Children in the props and `messages as never`, the way every sibling desktop render test
       hands the catalogue over: a JSON import widens past the provider's `AbstractIntlMessages`. */
    root?.render(h(NextIntlClientProvider, {
      locale: "en",
      messages: messages as never,
      timeZone: "UTC",
      children: h(DesktopAccessLock, { facts, onSignedOut: () => {} }),
    }));
  });
  // The way back is a BUTTON that mints its address at the press; no anchor carries the 402's.
  expect([...(host as HTMLDivElement).querySelectorAll("a")]).toEqual([]);
  return [...(host as HTMLDivElement).querySelectorAll("button.primary")].map((b) => b.textContent ?? "");
}

/** The Cloud door's words and presses under one distribution. */
async function cloudDoor(distribution: string): Promise<{ text: string; buttons: string[] }> {
  vi.resetModules();
  vi.doMock("../src/distribution.js", () => ({
    DISTRIBUTIONS: ["direct", "mas"],
    DISTRIBUTION: distribution,
    selfUpdates: () => distribution !== "mas",
    linksOutToBilling: () => distribution !== "mas",
  }));
  const { DoorChooser } = await import("../src/DoorChooser.js") as {
    DoorChooser: (p: { start: string; onEntered: () => void }) => React.ReactElement;
  };
  if (root) await act(() => { root?.unmount(); });
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host as HTMLDivElement);
  await act(() => {
    root?.render(h(NextIntlClientProvider, {
      locale: "en",
      messages: messages as never,
      timeZone: "UTC",
      children: h(DoorChooser, { start: "cloud", onEntered: () => {} }),
    }));
  });
  const el = host as HTMLDivElement;
  return { text: el.textContent ?? "", buttons: [...el.querySelectorAll("button")].map((b) => b.textContent ?? "") };
}

/** The mark every screen carries and Settings → About, under one distribution, as their text. */
async function markAndAbout(distribution: string, commit: string): Promise<{ mark: string; about: string }> {
  vi.resetModules();
  vi.doMock("../src/distribution.js", () => ({
    DISTRIBUTIONS: ["direct", "mas", "preview"],
    DISTRIBUTION: distribution,
    selfUpdates: () => distribution === "direct",
    linksOutToBilling: () => distribution === "direct",
    isPreview: () => distribution === "preview",
  }));
  vi.doMock("../src/build-id.js", () => ({ BUILD_LABEL: "1.0.11", BUILD_VERSION: "1.0.11", BUILD_SHA: commit }));
  const { PreviewMark } = await import("../src/PreviewMark.js") as { PreviewMark: () => React.ReactElement | null };
  const { DesktopAbout } = await import("../src/DesktopAbout.js") as {
    DesktopAbout: (p: { status: EngineStatus }) => React.ReactElement;
  };
  const status = { state: "serving", mode: "local", credentialState: "ready", address: "mila@preview.test", mailboxId: "mbx-1" } as EngineStatus;
  const text = async (node: React.ReactElement): Promise<string> => {
    if (root) await act(() => { root?.unmount(); });
    host?.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host as HTMLDivElement);
    await act(() => {
      root?.render(h(NextIntlClientProvider, { locale: "en", messages: messages as never, timeZone: "UTC", children: node }));
    });
    return (host as HTMLDivElement).textContent ?? "";
  };
  const out = { mark: await text(h(PreviewMark)), about: await text(h(DesktopAbout, { status })) };
  vi.doUnmock("../src/build-id.js");
  return out;
}

describe("the distribution decides two surfaces, and nothing else does", () => {
  it("the predicates answer per distribution, and `direct` is the control", () => {
    expect(selfUpdates("direct")).toBe(true);
    expect(linksOutToBilling("direct")).toBe(true);
    expect(selfUpdates("mas")).toBe(false);
    expect(linksOutToBilling("mas")).toBe(false);
    /* A nightly preview is replaced by the next night's build and has no hosted account to bill. */
    expect(selfUpdates("preview")).toBe(false);
    expect(linksOutToBilling("preview")).toBe(false);
    expect([isPreview("direct"), isPreview("mas"), isPreview("preview")]).toEqual([false, false, true]);
    /* Exactly three, so a fourth added without a decision about these surfaces fails here. */
    expect([...DISTRIBUTIONS]).toEqual(["direct", "mas", "preview"]);
  });

  it("a preview says it is one on every screen and in About, with its commit; a released build says nothing", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const preview = await markAndAbout("preview", commit);
    expect(preview.mark).toBe(messages.desktopDoor.previewMark.replace("{commit}", "0123456"));
    expect(preview.about).toContain(messages.desktopDoor.aboutPreviewLabel);
    expect(preview.about).toContain(commit);
    /* The next night's build is its update, so About offers no check of its own. */
    expect(preview.about).not.toContain(messages.update.label);

    const unstamped = await markAndAbout("preview", "");
    expect(unstamped.mark).toBe(messages.desktopDoor.previewMarkUnstamped);
    expect(unstamped.about).toContain(messages.desktopDoor.aboutPreviewUnstamped);

    /* THE CONTROL: the same two surfaces on the download build. */
    const direct = await markAndAbout("direct", commit);
    expect(direct.mark).toBe("");
    expect(direct.about).not.toContain(messages.desktopDoor.aboutPreviewLabel);
    expect(direct.about).not.toContain(commit);
  });

  it("the lock keeps its way back on the download build and drops it on the store build", async () => {
    expect(await lockAnchors("direct")).toEqual([messages.accessLock.manage]);
    expect(await lockAnchors("mas")).toEqual([]);
  });

  it("the lock still SAYS what happened on the store build — dropping the button is not silence", async () => {
    await lockAnchors("mas");
    const text = (host as HTMLDivElement).textContent ?? "";
    expect(text).toContain(messages.accessLock.kept);
    /* And the other door out is still there: a lock with no way out is a trap. */
    expect(text).toContain(messages.accessLock.signOut);
  });

  it("the Cloud door links to sign-up on the download build; the store build says the setup sentence only", async () => {
    const direct = await cloudDoor("direct");
    expect(direct.buttons).toContain(messages.desktopDoor.cloudCreateAccount);
    expect(direct.text).not.toContain(messages.desktopDoor.cloudSetupOnWeb);

    const mas = await cloudDoor("mas");
    expect(mas.buttons).not.toContain(messages.desktopDoor.cloudCreateAccount);
    expect(mas.text).not.toContain(messages.desktopDoor.cloudNoAccount);
    expect(mas.text).toContain(messages.desktopDoor.cloudSetupOnWeb);
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
    /* The window's literal is set from the same word the cargo features are selected by. */
    expect(build).toContain("OHMAIL_DISTRIBUTION: distribution");
    expect(build).toContain("buildVariant({ distribution, platform: process.platform })");
    expect(buildVariant({ distribution: "mas", platform: "darwin" }).features).toBe("local-engine,mas");
    expect(buildVariant({ distribution: "direct", platform: "darwin" }).features).toBe("local-engine");
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
