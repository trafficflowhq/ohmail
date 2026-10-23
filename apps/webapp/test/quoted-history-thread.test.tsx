/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installShellEnv, teardownShellEnv } from "./fixtures/live-walk-shell.js";
import { click, mountThread, msg, openTheRow, patches, settle } from "./fixtures/thread-read-shell.js";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";
import { qhFixtures, qhNorm } from "../../../packages/client-engine/test/quoted-history-fixtures.js";

/**
 * THE OWNER'S CASE IN THE SHIPPED SHELL: a conversation whose members each carry their quoted
 * history (an Outlook reply, a Gmail reply, an Exchange plain-text reply). Opened, every panel
 * shows its new words with the history folded behind its toggle; its end marker stands above the
 * toggle, so its top is its header and its own first lines; a folded member reads after the dwell,
 * and pressing a toggle reads or unreads nothing by itself.
 */
const FX = Object.fromEntries(qhFixtures().filter((f) => ["01", "13", "37"].includes(f.id)).map((f) => [f.id, f]));
const col = (): HTMLElement => document.querySelector<HTMLElement>(".read-col")!;
const panel = (id: string): HTMLElement => col().querySelector<HTMLElement>(`[data-conv-id="${id}"]`)!;
const glances = () => patches.filter((p) => p.via === "glance").map((p) => p.ids);
const follows = (a: Node, b: Node): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
let layout: ThreadLayout;

beforeAll(async () => {
  await import("../app/shell/AppShell.js");
  await import("@ohmail/ui");
}, 120_000);
beforeEach(() => {
  installShellEnv();
  layout = stubThreadLayout({ heights: { p1: 160, p2: 160, p3: 160 } });
  window.location.hash = "#/ohbox";
});
afterEach(async () => {
  layout.restore();
  await teardownShellEnv();
});

async function openThread(): Promise<void> {
  const host = await mountThread([msg("p1", 0), msg("p2", 10), msg("p3", 20)], {
    bodies: {
      p1: { text: FX["01"]!.text, html: FX["01"]!.html },
      p2: { text: FX["13"]!.text, html: FX["13"]!.html },
      p3: FX["37"]!.text,
    },
  });
  await openTheRow(host);
  await settle();
}

describe("a conversation of replies, each carrying its history", () => {
  it("every panel folds its history; its end marker stands above its toggle", async () => {
    await openThread();
    for (const [id, fx] of [["p1", FX["01"]!], ["p2", FX["13"]!], ["p3", FX["37"]!]] as const) {
      const p = panel(id);
      const toggle = p.querySelector<HTMLButtonElement>("button.msg-history-toggle");
      expect(toggle, `${id}: no toggle`).not.toBeNull();
      const start = fx.expect.html?.historyStartText ?? fx.expect.text!.historyStartLineNormalized!;
      expect(qhNorm(p.textContent ?? ""), `${id}: the history is on screen`).not.toContain(qhNorm(start));
      const first = fx.expect.html?.visibleFirstText ?? fx.expect.text!.visibleFirstLine!;
      expect(qhNorm(p.textContent ?? "")).toContain(qhNorm(first));
      const ends = p.querySelectorAll("[data-own-end]");
      expect(ends, `${id}: one end marker`).toHaveLength(1);
      expect(follows(ends[0]!, toggle!), `${id}: the end stands above the toggle`).toBe(true);
    }
  }, 60_000);

  it("a folded member reads after its dwell; a toggle press reads nothing by itself", async () => {
    await openThread();
    await layout.handScroll(layout.topOf("p2") - 10);
    await settle();
    const before = glances().length;
    await click(panel("p2").querySelector("button.msg-history-toggle"), "p2's toggle");
    expect(glances().length, "the press wrote nothing").toBe(before);
    expect(qhNorm(panel("p2").textContent ?? "")).toContain(qhNorm(FX["13"]!.expect.html!.historyStartText!));
    await layout.passDwell();
    await settle();
    expect(glances().flat()).toContain("p2");
  }, 60_000);
});
