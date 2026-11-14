/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureEntry } from "@ohmail/app/host";
import en from "../../messages/en.json";
import { json } from "../account/account-harness";
import {
  act, closeMailPage, CORRESPONDENT, inboxPage, ISO, mountMailPage, prepareMailPage, tick,
} from "../fixtures/mounted-mail-page";

const CARD = "The host's one card";
const hostNotices = (root: HTMLElement, hidden = false) =>
  within(root).queryAllByRole("status", { hidden }).filter((status) => status.textContent === CARD);
const useHostNotice: NonNullable<FeatureEntry["notice"]> = () => [{ kind: "mailLinks", title: CARD }];
const HOST_CARD = { name: "stageCard", render: () => null, notice: useHostNotice } satisfies FeatureEntry;
const seedRoutes = {
  "GET /api/consent": () => json({ seedConfirmedAt: null, dormancyDays: 60, onboardingCompletedAt: ISO }),
  "GET /api/consent/seed": () => json({
    candidates: [{ address: CORRESPONDENT, name: "A writer", messages: 2, lastWrittenAt: ISO, alreadyDecided: false }],
    excluded: [], scannedMessages: 2, truncated: false,
  }),
  "GET /api/sync": () => inboxPage(2),
};

vi.mock("../../app/(product)/mailbox/web-supplies", async (load) => {
  const real = await load<typeof import("../../app/(product)/mailbox/web-supplies")>();
  const { useMemo } = await import("react");
  return {
    ...real,
    useWebHost(...args: Parameters<typeof real.useWebHost>) {
      const host = real.useWebHost(...args);
      return useMemo(() => ({ ...host, features: { ...host.features, stageCard: HOST_CARD } }), [host]);
    },
  };
});

vi.mock("../../app/(product)/demo/host", async (load) => {
  const real = await load<typeof import("../../app/(product)/demo/host")>();
  const { DEMO_NOTICE } = await import("../../app/(product)/demo/notice");
  function useHostAndDemoNotices() {
    return [...useHostNotice(), ...DEMO_NOTICE.notice()];
  }
  return {
    ...real,
    demoHost(...args: Parameters<typeof real.demoHost>) {
      const host = real.demoHost(...args);
      return { ...host, features: { ...host.features, stageCard: { ...HOST_CARD, notice: useHostAndDemoNotices } } };
    },
  };
});

afterEach(closeMailPage);

async function press(button: HTMLElement): Promise<void> {
  await act(async () => { button.click(); });
}

async function visit(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await tick(0);
}

describe("host notices in the mounted mail frame", () => {
  it("the host notice and demo ribbon share one slot through Ohbox and News", async () => {
    await prepareMailPage();
    const page = await mountMailPage(true);
    for (const [hash, pane] of [["#/ohbox", "Messages"], ["#/reads", "News"]] as const) {
      await visit(hash);
      expect(page.getAllByRole("region", { name: pane }).length).toBeGreaterThan(0);
      expect(page.getAllByRole("button", { name: en.ribbon.dismiss })).toHaveLength(1);
      await press(page.getByRole("button", { name: /more notice/i }));
      await press(page.getByRole("menuitem", { name: CARD }));
      expect(hostNotices(page.container, true)).toHaveLength(1);
      await press(page.getByRole("button", { name: /more notice/i }));
      await press(page.getByRole("menuitem", { name: /^demo\b/i }));
    }
  }, 30_000);

  it("the host notice stands once above the seed review", async () => {
    await prepareMailPage(seedRoutes);
    const page = await mountMailPage();
    await tick(1_000);
    const dialog = page.getByRole("dialog", { name: en.frame.landmark.stage });
    const stage = within(dialog);
    const later = stage.getByRole("button", { name: en.seed.later });
    expect(hostNotices(page.container, true)).toHaveLength(1);
    expect(hostNotices(dialog)).toHaveLength(1);
    expect(hostNotices(dialog).some((card) => card.compareDocumentPosition(later) &
      Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  }, 30_000);

  it("shows the import offer once above the seed review, then returns the slot to the host", async () => {
    let declined = false;
    await prepareMailPage({
      ...seedRoutes,
      "GET /api/mailboxes/mb_1/profile-import": () => json(declined ? { state: "none" } : {
        state: "found", fingerprint: "b".repeat(64), updatedAt: ISO,
        producer: { kind: "local", version: "1.0.0" },
        counts: { screener: 3, rules: 2, notifyRules: 0, tags: 1, awayResponder: false },
      }),
      "POST /api/mailboxes/mb_1/profile-import/decline": () => {
        declined = true;
        return json({ dismissed: true });
      },
    });
    const page = await mountMailPage();
    await tick(1_000);
    const dialog = page.getByRole("dialog", { name: en.frame.landmark.stage });
    const stage = within(dialog);
    const offer = stage.getByRole("region", { name: en.profileImport.title });
    const review = stage.getByRole("heading", { level: 1, name: /written to/ });
    expect(page.getAllByRole("region", { name: en.profileImport.title, hidden: true })).toHaveLength(1);
    expect(offer.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hostNotices(dialog)).toHaveLength(0);
    await press(within(offer).getByRole("button", { name: en.profileImport.later }));
    await tick(0);
    expect(declined).toBe(true);
    expect(stage.queryByRole("region", { name: en.profileImport.title })).toBeNull();
    expect(hostNotices(dialog)).toHaveLength(1);
    expect(hostNotices(dialog).some((card) => card.compareDocumentPosition(review) &
      Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  }, 30_000);
});
