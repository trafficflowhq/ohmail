/** @vitest-environment jsdom */
import type { CalendarSetupPort } from "@ohmail/app-logic/calendar/setup";
/**
 * A way must be named by the server and have a working door in this host.
 */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarWay } from "@ohmail/app-logic/calendar/setup";
import { mirror, mountFrame, NONE, setupPort } from "./world.js";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

const capsules = () => {
  const group = screen.queryByRole("group", { name: "Ways to connect a calendar" });
  return group
    ? within(group)
        .queryAllByRole("button")
        .map((b) => b.textContent?.replace("↵", "").trim())
    : [];
};

describe("the ways drawn", () => {
  it("draws a capsule for each way the server lists that has a step, in the server's order", async () => {
    mountFrame(
      "#/cal/cal-setup",
      mirror(),
      setupPort(async () => ["ics", "microsoft", "icloud", "caldav"]),
    );
    await act(async () => undefined);
    expect(capsules()).toEqual(["A subscription", "iCloud", "Another CalDAV server"]);
    expect(screen.queryByText(/Google|Microsoft/)).toBeNull();
  });

  it.each([
    ["google", "Google"],
    ["microsoft", "Microsoft"],
  ] as const)("starts %s from its offered provider button", async (provider, label) => {
    const startOAuth = vi.fn(async () => undefined);
    mountFrame(
      "#/cal/cal-setup",
      mirror(),
      setupPort(async () => [provider], { startOAuth }),
    );
    const button = await screen.findByRole("button", { name: new RegExp(label) });
    await act(async () => fireEvent.click(button));
    expect(startOAuth).toHaveBeenCalledTimes(1);
    expect(startOAuth).toHaveBeenCalledWith(provider);
  });

  it.each([
    ["provider_off", "This calendar provider is unavailable."],
    ["calendar_off", "Turn on your calendar before connecting."],
    ["email_unverified", "Verify your email before connecting a calendar."],
    ["conflict", "Remove a calendar connection before adding another."],
  ] as const)("shows the reason when provider sign-in cannot start (%s)", async (reason, sentence) => {
    mountFrame(
      "#/cal/cal-setup",
      mirror(),
      setupPort(async () => ["google"], { startOAuth: async () => reason }),
    );
    const button = await screen.findByRole("button", { name: /Google Calendar/ });
    await act(async () => fireEvent.click(button));
    expect(screen.getByText(sentence, { selector: "[role=status]" })).toBeTruthy();
  });

  it("uses an existing Apple ID without sending any typed sign-in", async () => {
    const port = setupPort(async () => ["icloud"], {
      icloudMailboxes: async () => [{ id: "mailbox-id", address: ["studio", "example.test"].join("@") }],
    });
    const { address } = mountFrame("#/cal/cal-setup?step=signin&way=icloud", mirror(), port);
    const button = await screen.findByRole("button", { name: /Use the same Apple ID/ });
    await act(async () => fireEvent.click(button));
    expect(port.connect).toHaveBeenCalledTimes(1);
    expect(port.connect).toHaveBeenCalledWith({
      way: "icloud",
      fromMailbox: "mailbox-id",
      connectionId: expect.any(String),
    });
    expect(address.read()).toContain("step=calendars");
  });

  it.each(["", "&from=settings"])(
    "retries the same saved Apple ID once after the second factor%s",
    async (from) => {
      const connect = vi
        .fn<NonNullable<Exclude<CalendarSetupPort["connect"], "none">>>()
        .mockResolvedValueOnce({ kind: "step_up" })
        .mockResolvedValueOnce({ kind: "taken" });
      const port = setupPort(async () => ["icloud"], {
        connect,
        icloudMailboxes: async () => [{ id: "mailbox-id", address: ["studio", "example.test"].join("@") }],
        factor: ({ onVerified }) => <button onClick={onVerified}>Verify factor</button>,
      });
      const { address } = mountFrame(`#/cal/cal-setup?step=signin&way=icloud${from}`, mirror(), port);
      fireEvent.click(await screen.findByRole("button", { name: /Use the same Apple ID/ }));
      const verify = await screen.findByRole("button", { name: "Verify factor" });
      expect(connect).toHaveBeenCalledTimes(1);
      await act(async () => fireEvent.click(verify));
      expect(connect).toHaveBeenCalledTimes(2);
      expect(connect.mock.calls[0]).toEqual(connect.mock.calls[1]);
      expect(address.read()).toContain("step=calendars");
    },
  );

  it.each([
    [
      "en",
      "My calendar is with",
      "Ways to connect a calendar",
      "Not now",
      ["iCloud", "Another CalDAV server", "A subscription", "Google Calendar", "Microsoft Outlook"],
    ],
    [
      "de",
      "Mein Kalender ist bei",
      "Wege, einen Kalender zu verbinden",
      "Nicht jetzt",
      ["iCloud", "Ein anderer CalDAV-Server", "Ein Abo", "Google Kalender", "Microsoft Outlook"],
    ],
  ] as const)(
    "shows a plain heading and the offered buttons in %s",
    async (locale, title, group, leave, labels) => {
      mountFrame(
        "#/cal/cal-setup",
        mirror(),
        setupPort(async () => ["icloud", "caldav", "ics", "google", "microsoft"], {
          startOAuth: async () => undefined,
        }),
        { locale },
      );
      await act(async () => undefined);
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(
        within(screen.getByRole("group", { name: group }))
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(labels);
      expect(screen.getByRole("button", { name: leave })).toBeTruthy();
    },
  );

  it("folds an address that names a way not offered to the first step", async () => {
    for (const ways of [["google", "icloud"], ["icloud"]] as CalendarWay[][]) {
      mountFrame(
        "#/cal/cal-setup?step=signin&way=google",
        mirror(),
        setupPort(async () => ways),
      );
      await act(async () => undefined);
      expect(screen.queryByLabelText(/password/i)).toBeNull();
      expect(capsules()).toEqual(["iCloud"]);
      cleanup();
    }
  });

  it("draws no way when the list fails, throws or is not a list, and says so in one line", async () => {
    const failing: (() => Promise<readonly CalendarWay[]>)[] = [
      () => Promise.reject(new Error("offline")),
      () => {
        throw new Error("no door");
      },
      async () => ({ ways: ["icloud"] }) as unknown as CalendarWay[],
    ];
    for (const ways of failing) {
      mountFrame("#/cal/cal-setup?step=signin&way=icloud", mirror(), setupPort(ways));
      await act(async () => undefined);
      expect(capsules()).toEqual([]);
      expect(screen.queryByLabelText(/password/i)).toBeNull();
      expect(screen.getByRole("heading", { name: "No calendar can be connected from here" })).toBeTruthy();
      cleanup();
    }
  });

  it("offers nothing where connecting has no door, or where the host hands in no port", async () => {
    mountFrame(
      "#/cal/cal-setup",
      mirror(),
      setupPort(async () => ["icloud", "ics"], { connect: "none" }),
    );
    await act(async () => undefined);
    expect(capsules()).toEqual([]);
    cleanup();
    mountFrame("#/cal/cal-setup?step=signin&way=icloud", mirror(), NONE);
    await act(async () => undefined);
    expect(capsules()).toEqual([]);
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.getByRole("heading", { name: "No calendar can be connected from here" })).toBeTruthy();
  });
});
