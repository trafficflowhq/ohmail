// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../app/api-client";
import { completeCalendarOAuth, readCalendarOAuthReturn, startCalendarOAuth } from "../app/(product)/mailbox/calendar-oauth";

vi.mock("../app/api-client", async (original) => ({
  ...await original<typeof import("../app/api-client")>(),
  api: vi.fn(),
}));

const setup = "#/cal/cal-setup";
const code = "stand-in/code";
const state = "stand-in-state";

function arrive() {
  window.history.replaceState(null, "", `/${setup}?${new URLSearchParams({ oauth: "pending", provider: "google", state, code })}`);
  return readCalendarOAuthReturn()!;
}

afterEach(() => vi.resetAllMocks());

describe("calendar consent return", () => {
  it.each([
    [503, "oauth_unconfigured", { reason: "provider_off" }, "provider_off"],
    [409, "calendar_off", undefined, "calendar_off"],
    [403, "email_unverified", undefined, "email_unverified"],
  ] as const)("keeps the reason when starting answers %s %s", async (status, code, details, reason) => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(status, code, "fixture", details));
    expect(await startCalendarOAuth("google", "confirmed-account", () => true)).toBe(reason);
  });

  it("removes the inputs from the address before posting them for the confirmed account", async () => {
    const back = arrive();
    expect(window.location.hash).toBe(`${setup}?oauth=connecting`);
    expect(api).not.toHaveBeenCalled();

    vi.mocked(api).mockResolvedValueOnce({ connectionId: "calendar-fixture" });
    await completeCalendarOAuth(back, "confirmed-account", () => true);

    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/calendar/oauth/google/complete", {
      method: "POST", expectedOwner: "confirmed-account", body: { state, code },
    });
    expect(window.location.hash).toBe(`${setup}?step=calendars&connection=calendar-fixture&oauth=connected`);
  });

  it("shows the account refusal and replaces the interrupted return after a reload", async () => {
    const back = arrive();
    vi.mocked(api).mockRejectedValueOnce(new ApiError(403, "forbidden", "fixture", { reason: "account_mismatch" }));
    await completeCalendarOAuth(back, "confirmed-account", () => true);
    expect(window.location.hash).toBe(`${setup}?oauth=account_mismatch`);

    arrive();
    expect(readCalendarOAuthReturn()).toBe(null);
    expect(window.location.hash).toBe(`${setup}?oauth=state_invalid`);
  });
});
