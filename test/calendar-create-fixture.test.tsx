/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { eventTimeOf, intlZones } from "@ohmail/cal-core";
import { makeReader, makeWriter } from "../packages/cal-providers/src/caldav/index.js";
import { namedHostRequest } from "../packages/cal-providers/src/request/index.js";
import { startCalDavStandIn } from "../packages/cal-providers/test/caldav-stand-in.js";
import {
  calendarRecord,
  connectionRecord,
  mirror,
  mountFrame,
  NONE,
} from "../packages/app/test/calsetup/world.js";

afterEach(cleanup);

it("saves to an available CalDAV calendar while preferences are unavailable", async () => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  const dav = await startCalDavStandIn();
  try {
    dav.addCalendar("work", { name: "Work", privileges: ["read", "write"] });
    dav.addCalendar("home", { name: "Home", privileges: ["read", "write"] });
    dav.addCalendar("shared", { name: "Shared", privileges: ["read"] });
    const connection = {
      provider: "caldav" as const,
      start: `http://127.0.0.1:${dav.port}${dav.paths.start}`,
      credential: { kind: "basic" as const, user: dav.options.user, password: () => dav.options.password },
    };
    const zones = intlZones();
    const clock = { now: Date.now };
    const policy = { kind: "own-network" as const };
    const signal = new AbortController().signal;
    const listed = await makeReader({
      http: namedHostRequest({ writes: false, policy }),
      zones,
      clock,
    }).listCalendars(connection, signal);
    if (!listed.ok) throw new Error(listed.reason);
    const w = mirror();
    w.put("calendar_connection", "conn-1", connectionRecord());
    Object.assign(w.engine.store, {
      get: (kind: string, id: string) =>
        w.engine.store.entries<{ id: string }>(kind).find(({ entity }) => entity.id === id)?.entity,
    });
    for (const calendar of listed.value) {
      const id = calendar.name!.toLowerCase();
      w.put(
        "calendar",
        id,
        calendarRecord({ id, name: calendar.name!, access: calendar.writable ? "writer" : "reader" }),
      );
    }
    w.port.settings = () => Promise.reject(new Error("Preferences unavailable"));
    const writer = makeWriter({ http: namedHostRequest({ writes: true, policy }), zones, clock });
    w.port.press = async (act) => {
      if (act.kind !== "calendar_event_create") throw new Error("Expected an event creation");
      const target = listed.value.find((cal) => cal.name?.toLowerCase() === act.calendarId)!;
      const made = await writer.create(
        connection,
        target,
        {
          key: { hex: "0123456789abcdef0123456789abcdef" },
          event: {
            start: eventTimeOf(act.event.start)!,
            end: eventTimeOf(act.event.end)!,
            summary: act.event.title,
            description: null,
            location: null,
            url: null,
            organizer: null,
            busy: true,
            private: false,
            rule: null,
            attendees: [],
            alarms: [],
          },
        },
        signal,
      );
      if (!made.ok) throw new Error(made.reason);
      return { key: "created" };
    };
    mountFrame("#/cal/week/2026-11-16", w, NONE);
    fireEvent.click(screen.getByRole("button", { name: "New event" }));
    const form = within(screen.getByRole("dialog", { name: "New event" }));
    fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "Pottery" } });
    const add = form.getByRole<HTMLButtonElement>("button", { name: "Add" });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await vi.waitFor(() => expect(dav.seen.filter((request) => request.method === "PUT")).toHaveLength(1));
    expect(
      dav.seen.some((request) => request.method === "PUT" && request.body.includes("SUMMARY:Pottery")),
    ).toBe(true);
  } finally {
    await dav.close();
  }
});
