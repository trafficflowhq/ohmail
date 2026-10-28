/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * "GET OHMAIL FOR DESKTOP" — SHOWN IN THE SIGNED-IN BROWSER, NEVER IN THE DESKTOP APP ITSELF.
 *
 * The prompt invites a browser reader to install the desktop app, so it must not appear inside
 * that app. The shell's own platform tell is the injected `desktopSection` — the pane only a
 * native process can have — so its presence IS "this build is the desktop app". `showDesktopCta`
 * is that branch, made a pure value a test can drive; the demo is excluded because it is a shop
 * window, not an account.
 *
 * MUTATION WATCH: drop the `!opts.desktop` term and the desktop case goes red; drop `!opts.demo`
 * and the demo case does. Point the link away from the download section, or take the dismiss out,
 * and the component cases go red.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

beforeEach(() => { try { localStorage.clear(); } catch { /* no store */ } });
afterEach(async () => { await unmount(); vi.restoreAllMocks(); });

describe("the platform branch — where the prompt may appear", () => {
  it("shows only in the signed-in browser (not the desktop app, not the demo)", async () => {
    const { showDesktopCta } = await import("../app/shell/AppShell.js");
    expect(showDesktopCta({ demo: false, desktop: false }), "the signed-in browser must offer it").toBe(true);
    expect(showDesktopCta({ demo: false, desktop: true }), "the desktop app must NOT offer it").toBe(false);
    expect(showDesktopCta({ demo: true, desktop: false }), "the demo must NOT offer it").toBe(false);
  });
});

describe("the prompt component", () => {
  /**
   * Mounted as `AppShell` mounts it (2026-08-29, bug 3): the dismissal flag lives in the PARENT
   * (`usePersistedFlag` on the CTA's own key) and the parent renders the prompt only while the
   * flag is down — `DesktopCta` itself is controlled and never hides itself, because a child
   * that answers its dismissal with `null` leaves the rail's `.rail-mail` box standing around
   * nothing (the 14px dead band under the Command row, measured live). This harness is that
   * parent contract in miniature, so "dismiss hides it" and "dismissal persists" stay pinned
   * at the seam that now owns them.
   */
  async function mount(): Promise<void> {
    await unmount();
    const { DesktopCta, DESKTOP_CTA_DISMISSED } = await import("../app/shell/AppShell.js");
    const { usePersistedFlag } = await import("../app/shell/persisted-ui.js");
    function Foot(): React.ReactElement | null {
      const [dismissed, setDismissed] = usePersistedFlag(DESKTOP_CTA_DISMISSED, false);
      if (dismissed) return null;
      return h(DesktopCta, {
        href: "https://github.com/trafficflowhq/ohmail/releases/latest",
        label: "Get ohmail for desktop",
        dismissLabel: "Dismiss",
        onDismiss: () => setDismissed(true),
      });
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(Foot));
    });
  }

  it("links to the download section, in a new tab so the mailbox stays open", async () => {
    await mount();
    const link = host!.querySelector<HTMLAnchorElement>("a.rail-desktop-cta-link");
    expect(link, "no download link in the prompt").not.toBeNull();
    expect(link!.getAttribute("href"), "the prompt no longer points at the download section").toBe("https://github.com/trafficflowhq/ohmail/releases/latest");
    expect(link!.getAttribute("target"), "the download opens over the reader's mailbox").toBe("_blank");
    expect(link!.textContent).toContain("Get ohmail for desktop");
  });

  it("can be dismissed — and dismissal persists so it stays gone across a remount", async () => {
    await mount();
    const x = host!.querySelector<HTMLButtonElement>(".rail-desktop-cta-x")!;
    expect(x, "the prompt has no dismiss control").toBeTruthy();
    await act(async () => { x.click(); });
    expect(host!.querySelector(".rail-desktop-cta"), "dismiss did not hide the prompt").toBeNull();
    expect(localStorage.getItem("ohmail.desktopCtaDismissed"), "dismissal was not persisted").toBe("1");
    // The persistence half, proven rather than inferred: a fresh mount reads the flag back
    // (post-mount, `usePersistedFlag`'s hydration rule) and the prompt stays gone.
    await mount();
    expect(host!.querySelector(".rail-desktop-cta"), "a remount resurrected a dismissed prompt").toBeNull();
  });
});

describe("the prompt is wired into the rail footer on the platform branch", () => {
  it("the DISMISSAL flag is read inside ShellRail — the rail-only component — never on the shell", () => {
    /* The flag briefly lived beside the shell's other hooks, and `usePersistedFlag`'s
       post-mount read is a state write: every install that had dismissed the prompt paid a
       full re-render of the active hundreds-of-rows view once per mount, plus once more on
       the press itself — the exact cost the `ShellRail` note documents for `tagsOpen` and the
       reason that flag was moved down. One read, and it sits between `ShellRail`'s and
       `AppShell`'s definitions, so a regression that hoists it back onto the shell goes red
       here rather than as a five-second wait. */
    const shell = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/AppShell.tsx"), "utf8");
    const reads = [...shell.matchAll(/usePersistedFlag\(DESKTOP_CTA_DISMISSED/g)];
    expect(reads, "the dismissal flag must be read exactly once").toHaveLength(1);
    const at = reads[0]!.index!;
    const railAt = shell.indexOf("function ShellRail(");
    const appShellAt = shell.indexOf("export function AppShell(");
    expect(railAt).toBeGreaterThan(-1);
    expect(appShellAt).toBeGreaterThan(railAt);
    expect(at, "the flag read left ShellRail").toBeGreaterThan(railAt);
    expect(at, "the flag read was hoisted onto the shell").toBeLessThan(appShellAt);
  });

  it("the footer renders `DesktopCta` gated by `showDesktopCta`, keyed on the desktop tell", () => {
    const shell = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/AppShell.tsx"), "utf8");
    // The gate reads the desktop tell (`desktopSection != null`) and the mode, and the node it
    // guards is the prompt pointing at the download section.
    expect(shell, "the footer no longer gates the prompt on the platform tell").toMatch(
      /showDesktopCta\(\{\s*demo,\s*desktop:\s*desktopSection != null\s*\}\)/,
    );
    expect(shell, "the footer no longer renders the desktop prompt").toMatch(
      /<DesktopCta[\s\S]*href=\{DESKTOP_DOWNLOAD_URL\}/,
    );
  });
});
