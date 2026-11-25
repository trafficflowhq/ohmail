/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TICK_MS, WRITE_SETTLE_MS } from "@ohmail/app-logic/mailboxes/pane/rows";
import { fakeDoor } from "../connect/support.js";
import { A, B, M, NOW, drawPane, fakePane, ok, refusal, row } from "./support.js";

/**
 * THE MAILBOXES PANE, AS A PERSON MEETS IT: one row per mailbox that opens in place, the connect offer that goes to
 * the first run's add run, the connect form mounted in the opened row for an edit, a sign-in's return said, and the
 * list kept honest: counts read once, a tick that never asks for them and stops while nobody looks, and the last
 * rows kept over a refused read.
 */
const settle = (): Promise<void> => act(async () => {});
const tick = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const rowButton = (address: string) =>
  screen.getByRole("button", { name: new RegExp(address.replace(".", "\\.")) });
const ALLOWED = ok({ emailVerified: true, access: null });
const say = (sentence: string, values: Record<string, string>): string =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, v), sentence);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the list", () => {
  it("asks for counts once as the pane opens; the tick never asks for them", async () => {
    const pane = fakePane({
      list: [ok([row("mbx-a", A, { messageCount: 12 })]), ok([row("mbx-a", A)])],
      allowance: [ALLOWED],
    });
    drawPane(pane.wire);
    await settle();
    await tick(TICK_MS);
    expect(pane.of("list").map((c) => c.args[0])).toEqual([{ counts: true }, { counts: false }]);
    expect(screen.getByText(/12 messages/)).toBeTruthy();
  });

  it("a hidden tab reads nothing on the tick", async () => {
    const pane = fakePane({ list: [ok([row("mbx-a", A)])], allowance: [ALLOWED] });
    drawPane(pane.wire, { hidden: () => true });
    await settle();
    await tick(TICK_MS * 3);
    expect(pane.of("list")).toHaveLength(1);
  });

  it("a refused read keeps the last rows and says the server's sentence", async () => {
    const down = {
      ok: false as const,
      refusal: refusal("unavailable", {}, 503, "The service is down for a moment."),
    };
    const pane = fakePane({ list: [ok([row("mbx-a", A)]), down], allowance: [ALLOWED] });
    drawPane(pane.wire);
    await settle();
    await tick(TICK_MS);
    expect(rowButton(A)).toBeTruthy();
    expect(screen.getByText("The service is down for a moment.")).toBeTruthy();
    expect(screen.queryByText(M.noneYet)).toBeNull();
  });

  it("a first read refused says neither 'reading' nor 'none yet'", async () => {
    const down = {
      ok: false as const,
      refusal: refusal("unavailable", {}, 503, "The service is down for a moment."),
    };
    const pane = fakePane({ list: [down], allowance: [ALLOWED] });
    drawPane(pane.wire);
    await settle();
    expect(screen.queryByText(M.loading)).toBeNull();
    expect(screen.queryByText(M.noneYet)).toBeNull();
  });

  it("one row per address: a disabled entry stands behind the live one as a footnote", async () => {
    const pane = fakePane({
      list: [ok([row("mbx-old", A, { status: "disabled" }), row("mbx-a", A)])],
      allowance: [ALLOWED],
    });
    drawPane(pane.wire, { opened: "mbx-a" });
    await settle();
    expect(screen.getAllByRole("button", { name: new RegExp(A.replace(".", "\\.")) })).toHaveLength(1);
    expect(screen.getByText(M.superseded)).toBeTruthy();
  });
});

describe("rows open in place", () => {
  it("a press opens a row and the same press closes it; two can stand open", async () => {
    const pane = fakePane({ list: [ok([row("mbx-a", A), row("mbx-b", B)])], allowance: [ALLOWED] });
    drawPane(pane.wire);
    await settle();
    fireEvent.click(rowButton(A));
    fireEvent.click(rowButton(B));
    expect(rowButton(A).getAttribute("aria-expanded")).toBe("true");
    expect(rowButton(B).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(rowButton(A));
    expect(rowButton(A).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("an opened row says its state with its exact time", () => {
  const exact = (iso: string): string =>
    new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(
      new Date(iso),
    );

  it("a synced mailbox: when it last synced, to the minute, as a setting's line", async () => {
    const pane = fakePane({ list: [ok([row("mbx-a", A)])], allowance: [ALLOWED] });
    drawPane(pane.wire, { opened: "mbx-a" });
    await settle();
    const line = screen.getByRole("group", { name: M.lineSynced });
    expect(line.textContent).toContain("08:58");
  });

  it("a failing mailbox gives a localized reason, the exact time and the attempt count", async () => {
    const failing = row("mbx-a", A, {
      status: "error",
      errorCode: "imap_auth",
      errorDetail: "ETIMEDOUT",
      failedAt: "2026-11-16T07:00:00.000Z",
      retryCount: 3,
    });
    const pane = fakePane({ list: [ok([failing])], allowance: [ALLOWED] });
    drawPane(pane.wire, { opened: "mbx-a" });
    await settle();
    const since = say(M.errSince, { when: exact("2026-11-16T07:00:00.000Z") });
    const value = screen.getByText(`${since} · ${say(M.errAttempts, { count: "3" })}`);
    expect(value.closest('[role="group"]')).toBe(screen.getByRole("group", { name: M.err_auth }));
    expect(screen.queryByText(/ETIMEDOUT/)).toBeNull();
    expect(screen.queryByTitle(/ETIMEDOUT/)).toBeNull();
  });
});

describe("connecting goes to the first run's add run", () => {
  it("Connect a mailbox is a button named by mailboxes.connect that opens the add run and calls nothing", async () => {
    const pane = fakePane({ list: [ok([row("mbx-a", A)])], allowance: [ALLOWED] });
    const view = drawPane(pane.wire, { connect: fakeDoor().door });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: M.connect }));
    expect(view.went).toEqual(["add"]);
    expect(pane.writes()).toEqual([]);
  });

  it("Run setup again opens the run again", async () => {
    const pane = fakePane({ list: [ok([row("mbx-a", A)])], allowance: [ALLOWED] });
    const view = drawPane(pane.wire, { connect: fakeDoor().door });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: M.setupAgain }));
    expect(view.went).toEqual(["again"]);
  });

  it("a proven block withholds the offer and says why; an unknown never does", async () => {
    const full = ok({ emailVerified: true, access: { canAddMailbox: true, mailboxes: 1 } });
    const pane = fakePane({ list: [ok([row("mbx-a", A)])], allowance: [full] });
    const viewForLimit = drawPane(pane.wire, { connect: fakeDoor().door });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: M.connect }));
    const limit = screen.getByRole("dialog", { name: "1 of 1 mailboxes" });
    expect(limit.textContent).toContain(M.limitLine);
    expect(viewForLimit.went).toEqual([]);

    cleanup();
    const unknown = fakePane({
      list: [ok([row("mbx-a", A)])],
      allowance: [ok({ emailVerified: null, access: null })],
    });
    drawPane(unknown.wire, { connect: fakeDoor().door });
    await settle();
    expect(screen.getByRole("button", { name: M.connect })).toBeTruthy();
  });
});

describe("an edit is the one connect form, in the opened row", () => {
  it("Edit mounts the form for that mailbox; a saved edit re-reads the list and tells the mail state and the sync", async () => {
    const door = fakeDoor({ edit: [ok(null)] });
    const pane = fakePane({
      list: [ok([row("mbx-a", A)]), ok([row("mbx-a", A)])],
      allowance: [ALLOWED, ALLOWED],
    });
    const view = drawPane(pane.wire, { connect: door.door, opened: "mbx-a" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: M.edit }));
    expect(screen.getByText(say(M.editTitle, { address: A }))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(M.passwordLabel), { target: { value: "a new one" } });
    fireEvent.click(screen.getByRole("button", { name: M.continue }));
    await settle();
    expect(door.of("edit").map((c) => (c.sent as { mailboxId: string }).mailboxId)).toEqual(["mbx-a"]);
    expect(view.drained).toEqual(["refresh", "sync"]);
    expect(screen.queryByText(say(M.editTitle, { address: A }))).toBeNull();
  });
});

describe("a provider's sign-in that came back is said here", () => {
  const microsoft = { ways: { microsoft: { redirect: true, device: false } } } as const;

  it("connected: the shipped sentence, a re-read and the mail state told", async () => {
    const door = fakeDoor({ ...microsoft, returned: { kind: "connected", created: true, address: B } });
    const pane = fakePane({
      list: [ok([row("mbx-a", A)]), ok([row("mbx-a", A), row("mbx-b", B)])],
      allowance: [ALLOWED],
    });
    const view = drawPane(pane.wire, { connect: door.door });
    await settle();
    expect(screen.getByText(say(M.oauthConnected, { address: B }))).toBeTruthy();
    expect(view.drained).toEqual(["refresh", "sync"]);
  });

  it("a declined consent is said calmly, as a status and never as an alert", async () => {
    const door = fakeDoor({ ...microsoft, returned: { kind: "refused", reason: "consent_declined" } });
    const pane = fakePane({ list: [ok([row("mbx-a", A)])], allowance: [ALLOWED] });
    drawPane(pane.wire, { connect: door.door });
    await settle();
    const said = screen.getByText(M.oauth_consent_declined);
    expect(said.closest('[role="status"]')).not.toBeNull();
    expect(said.closest('[role="alert"]')).toBeNull();
  });

  it("a sign-in that failed says the server's sentence, as an alert", async () => {
    const door = fakeDoor({
      ...microsoft,
      returned: { kind: "failed", reason: null, message: "The provider did not answer in time." },
    });
    const pane = fakePane({ list: [ok([row("mbx-a", A)])], allowance: [ALLOWED] });
    drawPane(pane.wire, { connect: door.door });
    await settle();
    expect(screen.getByText("The provider did not answer in time.").closest('[role="alert"]')).not.toBeNull();
  });

  it("while it finishes, the pane says so", async () => {
    const door = fakeDoor({ ...microsoft, returned: { kind: "running" } });
    const pane = fakePane({ list: [ok([row("mbx-a", A)])], allowance: [ALLOWED] });
    drawPane(pane.wire, { connect: door.door });
    await settle();
    expect(screen.getByText(M.oauthFinishing)).toBeTruthy();
  });
});

describe("after a write, the rows from before it are never shown as its result", () => {
  it("a removal whose re-read does not answer in time hides the rows behind the honest sentence", async () => {
    const pane = fakePane({ list: [ok([row("mbx-a", A)])], allowance: [ALLOWED], remove: [ok(null)] });
    drawPane(pane.wire, { opened: "mbx-a" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: M.remove }));
    fireEvent.click(screen.getByRole("button", { name: M.removeConfirm }));
    await settle();
    await tick(WRITE_SETTLE_MS);
    expect(screen.getByText(M.listBehind)).toBeTruthy();
    expect(screen.queryByRole("button", { name: new RegExp(A.replace(".", "\\.")) })).toBeNull();
  });
});
