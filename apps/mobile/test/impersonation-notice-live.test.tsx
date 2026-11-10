/** @vitest-environment jsdom */
/**
 * THE SCREENER TAB'S IMPERSONATION LINE FOLLOWS A FILING MADE WHILE IT IS OPEN, rendered. The phone
 * organizes only while the app runs, and the line read its list once per mount: a letter filed to
 * Spam for claiming a company was not counted, listed or offered Put back until a cold start, while
 * the Spam tab's count moved at once. The line now asks again whenever Spam's letters change, one
 * read at a time.
 */
import { act, createElement as h, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => ({ ...(await import("./_rendered-dom")).rnDom }));
vi.mock("../src/ui/base", () => ({
  Panel: (p: { children?: ReactNode }) => h("div", { "data-panel": "" }, p.children),
  Txt: (p: { children?: ReactNode }) => h("span", { "data-txt": "" }, p.children),
  Button: (p: { label: string; onPress: () => void }) => h("button", { onClick: p.onPress }, p.label),
}));
vi.mock("../src/state/store", () => ({ usePrefs: () => ({ impersonationSeen: "", setImpersonationSeen: () => undefined }) }));
vi.mock("../src/state/live", () => ({ isSharedProviderDomain: () => false }));

const { mount } = await import("./_rendered-dom");
const { ImpersonationNotice } = await import("../src/ui/ImpersonationNotice");
const { spamLettersMark } = await import("../src/ui/impersonation-notice");

const PHISH = {
  messageId: "p1", from: "billing@hosting-renewals.example", subject: "Zahlung", to: "ohmail/Quarantine",
  filedAt: "2026-11-09T11:00:00.000Z", why: "impersonation", brand: "Metanet",
};
let filed: unknown[] = [];
let reads = 0;
let gate: Promise<void> | null = null;
let down = false;
const session = {
  profile: { origin: "http://door.test", apiBase: null },
  fetch: async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return new Response(JSON.stringify({ putBack: ["p1"], requested: [] }), { status: 200 });
    if (!url.endsWith("/screener/auto-filed")) return new Response("{}", { status: 404 });
    reads++;
    if (gate !== null) await gate;
    if (down) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify({ items: filed, more: false }), { status: 200 });
  },
} as never;

const spamOf = (...ids: string[]) => spamLettersMark([{ held: ids.map((id) => ({ id })) }]);
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
let view: ReturnType<typeof mount> | null = null;
afterEach(() => { view?.unmount(); view = null; filed = []; reads = 0; gate = null; down = false; });

describe("the impersonation line on the Screener tab", () => {
  it("a letter filed to Spam while the tab is open shows in the line and Review at once", async () => {
    view = mount(h(ImpersonationNotice, { session, spamMark: spamOf("x1") }));
    await settle();
    expect(view.el.textContent).toBe("");
    filed = [PHISH];
    view.render(h(ImpersonationNotice, { session, spamMark: spamOf("x1", "p1") }));
    await settle();
    expect(view.el.textContent).toContain("1 letter that claimed to be a company went to Spam");
    await act(async () => { [...view!.el.querySelectorAll("button")].find((b) => b.textContent === "Review")!.click(); });
    expect(view.el.textContent).toContain("billing@hosting-renewals.example");
    expect([...view.el.querySelectorAll("button")].some((b) => b.textContent === "Put back")).toBe(true);
  });

  it("asks again only when Spam's letters change, and once for changes landing during a read", async () => {
    view = mount(h(ImpersonationNotice, { session, spamMark: spamOf("x1") }));
    await settle();
    expect(reads).toBe(1);
    view.render(h(ImpersonationNotice, { session, spamMark: spamOf("x1") }));
    await settle();
    expect(reads, "a render with the same Spam asked again").toBe(1);
    let open!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    for (const more of [["q1"], ["q1", "q2"], ["q1", "q2", "q3"]]) {
      view.render(h(ImpersonationNotice, { session, spamMark: spamOf("x1", ...more) }));
      await settle();
    }
    expect(reads, "each change during the read asked on its own").toBe(2);
    filed = [PHISH];
    gate = null;
    await act(async () => { open(); });
    await settle();
    expect(reads, "the changes during the read were not asked about after it").toBe(3);
    expect(view.el.textContent).toContain("1 letter that claimed to be a company went to Spam");
  });

  it("a failed read after a Spam change keeps the line, Review and Put back", async () => {
    filed = [PHISH];
    view = mount(h(ImpersonationNotice, { session, spamMark: spamOf("p1") }));
    await settle();
    await act(async () => { [...view!.el.querySelectorAll("button")].find((b) => b.textContent === "Review")!.click(); });
    down = true;
    view.render(h(ImpersonationNotice, { session, spamMark: spamOf("p1", "q1") }));
    await settle();
    expect(reads).toBe(2);
    expect(view.el.textContent).toContain("1 letter that claimed to be a company went to Spam");
    expect([...view.el.querySelectorAll("button")].some((b) => b.textContent === "Put back")).toBe(true);
  });
});
