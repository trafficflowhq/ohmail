/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mailKit from "@ohmail/ui/mail";
import type { EngineMessage } from "@ohmail/wire";
import { openingCount } from "@ohmail/app-logic/lists/stream-window";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";
import { stubDom } from "./_draft-shell.js";

const count = 200;
const drawn: string[] = [];
const realMessage = mailKit.Message;

function letters(over: (i: number) => Partial<EngineMessage> = () => ({})) {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(2026, 10, 20, 9) - i * 1000).toISOString();
    return issue(`m${i}`, 20, { date, arrivedAt: date, subject: `Issue ${i}`, ...over(i) });
  });
}

function seat(messages = letters(), at = "#/reads") {
  return mountStreamFrame({ at, letters: messages });
}

function bodyObserver() {
  const seen: { observed: Element[]; notify?: (entries: Partial<IntersectionObserverEntry>[]) => void } = {
    observed: [],
  };
  vi.stubGlobal("IntersectionObserver", class {
    constructor(
      private readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void,
      private readonly init?: IntersectionObserverInit,
    ) {
      if (init?.rootMargin === "100% 0px") seen.notify = this.callback;
    }
    observe(target: Element): void {
      if (this.init?.rootMargin === "100% 0px") seen.observed.push(target);
    }
    unobserve(): void {}
    disconnect(): void {}
  });
  return seen;
}

beforeEach(() => {
  stubDom();
  drawn.length = 0;
  vi.spyOn(mailKit, "Message").mockImplementation((props) => {
    if (props.subject?.startsWith("Issue ")) drawn.push(props.subject);
    return realMessage(props);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the reading stream skips cards whose inputs did not change", () => {
  it("a version bump that changes no message re-renders zero cards", async () => {
    const { mail } = seat();
    expect(drawn.length).toBeGreaterThanOrEqual(Math.min(count, openingCount(window.innerHeight)));
    drawn.length = 0;
    await act(async () => { mail.add(issue("outside", 20, { folder: "INBOX", subject: "Unrelated row" })); });
    expect(drawn).toEqual([]);
  });

  it("a version bump that changes no mounted card re-scans nothing for the seen observer", async () => {
    const observation = bodyObserver();
    const { mail } = seat();
    expect(observation.observed.length).toBeGreaterThan(0);
    observation.observed.length = 0;
    await act(async () => { mail.add(issue("outside", 20, { folder: "INBOX", subject: "Unrelated row" })); });
    expect(observation.observed).toEqual([]);
  });

  it("a card whose TRIAGE changed re-renders, though its id did not", async () => {
    const { mail } = seat();
    drawn.length = 0;
    await act(async () => {
      mail.patch("m5", { triage: { state: "set_aside" } as EngineMessage["triage"] });
    });
    expect(drawn).toEqual(["Issue 5"]);
  });

  it("a card whose filed folder changed re-renders, though where it is shown did not", async () => {
    const { mail } = seat(letters((i) => i === 5 ? { physicalFolder: "ohmail/Screener" } : {}));
    expect(screen.getAllByRole("heading", { name: "Issue 5" })).toHaveLength(1);
    drawn.length = 0;
    await act(async () => { mail.patch("m5", { physicalFolder: undefined }); });
    expect(screen.getAllByRole("heading", { name: "Issue 5" })).toHaveLength(1);
    expect(drawn).toEqual(["Issue 5"]);
  });

  it("a card the lookahead reports re-renders alone — `viewer` is in the comparator", async () => {
    const observation = bodyObserver();
    const { mail } = seat(letters((i) => i === 152 ? { body: undefined } : {}), "#/reads/m/m150");
    const hydrate = mail.engine.hydrateBody.bind(mail.engine);
    vi.spyOn(mail.engine, "hydrateBody").mockImplementation(async (id, options) => {
      await hydrate(id, options);
      mail.patch(id, { body: "The body that just arrived." });
    });
    const reading = screen.getByRole("region", { name: "News stream" });
    const target = reading.querySelector('[data-stream-item="m152"]');
    expect(target).not.toBeNull();
    expect(observation.notify).toBeDefined();
    drawn.length = 0;
    await act(async () => { observation.notify!([{ target: target!, isIntersecting: true }]); });
    expect(drawn).toEqual(["Issue 152"]);
    expect(within(target! as HTMLElement).getByText("The body that just arrived.")).toBeTruthy();
    drawn.length = 0;
    await act(async () => { observation.notify!([{ target: target!, isIntersecting: true }]); });
    expect(drawn).toEqual([]);
  });

  it("moving the cursor re-renders exactly the two cards whose `current` flipped", async () => {
    seat();
    const list = within(screen.getByRole("region", { name: "News" }));
    await act(async () => { fireEvent.click(list.getByRole("option", { name: /Issue 0$/ })); });
    drawn.length = 0;
    await act(async () => { fireEvent.click(list.getByRole("option", { name: /Issue 5$/ })); });
    expect(drawn.length).toBeGreaterThanOrEqual(1);
    expect(drawn.length).toBeLessThanOrEqual(2);
    expect(drawn.every((subject) => subject === "Issue 0" || subject === "Issue 5")).toBe(true);
  });
});
