import { MutationRejectedError, type CalendarSetupTransport } from "@ohmail/client-engine";
import { expect, it, vi } from "vitest";
import { calendarSetupPortOf } from "../../../src/calendar/setup/port-of.js";

it("finishes a disconnect when the worker removes the connection between requests", async () => {
  const gone = new MutationRejectedError("Calendar connection missing", { code: "not_found", status: 404 });
  const removeCalendarConnection = vi
    .fn()
    .mockResolvedValueOnce({ removed: false })
    .mockRejectedValueOnce(gone);
  const sync = vi.fn(async () => {});
  const port = calendarSetupPortOf(
    { removeCalendarConnection } as unknown as CalendarSetupTransport,
    sync,
    () => "unused",
  );
  await expect(port.remove("calendar")).resolves.toBeUndefined();
  expect(removeCalendarConnection.mock.calls).toEqual([["calendar"], ["calendar"]]);
  expect(sync).toHaveBeenCalledOnce();
});

it("reports a missing connection when the first disconnect request is refused", async () => {
  const gone = new MutationRejectedError("Calendar connection missing", { code: "not_found", status: 404 });
  const removeCalendarConnection = vi.fn().mockRejectedValue(gone);
  const port = calendarSetupPortOf(
    { removeCalendarConnection } as unknown as CalendarSetupTransport,
    async () => {},
    () => "unused",
  );
  await expect(port.remove("calendar")).rejects.toBe(gone);
  expect(removeCalendarConnection).toHaveBeenCalledOnce();
});
