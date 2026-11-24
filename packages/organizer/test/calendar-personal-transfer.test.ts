import { expect, it, vi } from "vitest";
import { DEFAULT_LIMITS, intlZones, readCalendar } from "@ohmail/cal-core";
import type { CalendarWriter, Connection } from "@ohmail/cal-providers";
import { transferPersonalEvent } from "../src/calendar/personal-transfer.js";

const signal = new AbortController().signal;
const connection = { provider: "google" } as Connection;
const cal = { id: "calendar" };
const upsert = (id: string, version: string) => {
  const parsed = readCalendar(
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${id}`,
      "DTSTAMP:20261118T080000Z",
      "DTSTART:20261118T090000Z",
      "DTEND:20261118T100000Z",
      "SUMMARY:Paint",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n"),
    DEFAULT_LIMITS,
  );
  if (!parsed.ok || !parsed.calendar.events[0]) throw new Error("Invalid calendar fixture");
  return {
    kind: "upsert" as const,
    id,
    version,
    event: parsed.calendar.events[0],
    text: null,
    portableCopy: true as const,
  };
};
const sourceItem = upsert("original", '"one"');
const copyItem = upsert("copy", '"two"');
const fields = {
  title: "Paint",
  start: { kind: "instant", value: "20261118T090000Z" },
  end: { kind: "instant", value: "20261118T100000Z" },
  notes: null,
  place: null,
  callLink: null,
  busy: true,
  private: false,
  repeat: null,
  invitees: [] as [],
  alarms: [] as [],
} as const;
const read = (item: typeof sourceItem) => ({ ok: true as const, items: [item] });
const gone = (id: string) => ({ ok: true as const, items: [{ kind: "gone" as const, id }] });
const refusal = { ok: false as const, reason: "version_stale" as const, retryAfterMs: null };

function fixture(failSource = false, changedCopy = false) {
  const history: string[] = [];
  const source = {
    readForMove: vi.fn(async () => {
      history.push("read original");
      return read(sourceItem);
    }),
    remove: vi.fn(async () => {
      history.push("remove original");
      return failSource ? refusal : gone("original");
    }),
  } as unknown as CalendarWriter;
  const destination = {
    create: vi.fn(async () => {
      history.push("create copy");
      return read(copyItem);
    }),
    readForMove: vi.fn(async () => {
      history.push("read copy");
      return read(
        changedCopy
          ? { ...copyItem, event: { ...copyItem.event, description: "A different value" } }
          : copyItem,
      );
    }),
    remove: vi.fn(async () => {
      history.push("remove copy");
      return gone("copy");
    }),
  } as unknown as CalendarWriter;
  return { history, source, destination };
}

it("reads the copy before removing the original under its reviewed version", async () => {
  const f = fixture();
  const answer = await transferPersonalEvent({
    source: { writer: f.source, connection, cal },
    destination: { writer: f.destination, connection, cal },
    transfer: { source: sourceItem.id, fields: { ...fields, invitees: [], alarms: [] } },
    originalVersion: sourceItem.version,
    key: { hex: "a".repeat(32) },
    zones: intlZones(),
    signal,
    remember: async () => true,
  });
  expect(answer).toMatchObject({ ok: true, items: [{ kind: "gone", id: sourceItem.id }] });
  expect(f.history).toEqual([
    "read original",
    "create copy",
    "read copy",
    "read original",
    "remove original",
  ]);
  expect(f.source.remove).toHaveBeenCalledWith(
    connection,
    cal,
    expect.objectContaining({ version: '"one"' }),
    signal,
  );
});

it.each([
  [true, false],
  [false, true],
])("removes only the copy on refusal or read-back mismatch", async (failSource, changedCopy) => {
  const f = fixture(failSource, changedCopy);
  const phases: string[] = [];
  const answer = await transferPersonalEvent({
    source: { writer: f.source, connection, cal },
    destination: { writer: f.destination, connection, cal },
    transfer: { source: sourceItem.id, fields: { ...fields, invitees: [], alarms: [] } },
    originalVersion: sourceItem.version,
    key: { hex: "a".repeat(32) },
    zones: intlZones(),
    signal,
    remember: async ({ phase }) => {
      phases.push(phase);
      return true;
    },
  });
  expect(answer).toMatchObject({ ok: false });
  expect(f.source.remove).toHaveBeenCalledTimes(failSource ? 1 : 0);
  expect(f.destination.remove).toHaveBeenCalledWith(
    connection,
    cal,
    expect.objectContaining({ id: "copy", version: '"two"' }),
    signal,
  );
  expect(phases.at(-1)).toBe("rollback");
});

it("keeps the verified copy when an interrupted original removal already landed", async () => {
  const f = fixture();
  vi.mocked(f.source.readForMove!).mockResolvedValueOnce(gone(sourceItem.id));
  const answer = await transferPersonalEvent({
    source: { writer: f.source, connection, cal },
    destination: { writer: f.destination, connection, cal },
    transfer: {
      source: sourceItem.id,
      fields: { ...fields, invitees: [], alarms: [] },
      progress: { phase: "removing", id: copyItem.id, version: copyItem.version },
    },
    originalVersion: sourceItem.version,
    key: { hex: "a".repeat(32) },
    zones: intlZones(),
    signal,
    remember: async () => true,
  });
  expect(answer).toEqual(gone(sourceItem.id));
  expect(f.source.remove).not.toHaveBeenCalled();
  expect(f.destination.remove).not.toHaveBeenCalled();
  expect(f.destination.create).not.toHaveBeenCalled();
});

it.each([false, true])(
  "rechecks the contents of a copy with a newer version (changed: %s)",
  async (changed) => {
    const f = fixture();
    const copy = {
      ...copyItem,
      version: '"new"',
      event: { ...copyItem.event, description: changed ? "Edited" : null },
    };
    vi.mocked(f.destination.readForMove!).mockResolvedValueOnce(read(copy));
    const answer = await transferPersonalEvent({
      source: { writer: f.source, connection, cal },
      destination: { writer: f.destination, connection, cal },
      transfer: {
        source: sourceItem.id,
        fields,
        progress: { phase: "verifying", id: copyItem.id, version: copyItem.version },
      },
      originalVersion: sourceItem.version,
      key: { hex: "a".repeat(32) },
      zones: intlZones(),
      signal,
      remember: async () => true,
    });
    expect(answer).toMatchObject(changed ? { ok: false, reason: "version_stale" } : { ok: true });
    if (changed)
      expect(f.destination.remove).toHaveBeenCalledWith(
        connection,
        cal,
        expect.objectContaining({ version: '"new"' }),
        signal,
      );
    else expect(f.source.remove).toHaveBeenCalledTimes(1);
  },
);

it("removes its copy when the original disappears before it attempted any removal", async () => {
  const f = fixture();
  vi.mocked(f.source.readForMove!).mockResolvedValueOnce(gone(sourceItem.id));
  const answer = await transferPersonalEvent({
    source: { writer: f.source, connection, cal },
    destination: { writer: f.destination, connection, cal },
    transfer: {
      source: sourceItem.id,
      fields,
      progress: { phase: "verifying", id: copyItem.id, version: copyItem.version },
    },
    originalVersion: sourceItem.version,
    key: { hex: "a".repeat(32) },
    zones: intlZones(),
    signal,
    remember: async () => true,
  });
  expect(answer).toMatchObject({ ok: false, reason: "version_stale" });
  expect(f.destination.remove).toHaveBeenCalledTimes(1);
  expect(f.source.remove).not.toHaveBeenCalled();
});

it("reads the destination again before reporting a copy left after a lost rollback reply", async () => {
  const f = fixture();
  const markDue = vi.fn(async () => {});
  vi.mocked(f.destination.readForMove!)
    .mockResolvedValueOnce(read(copyItem))
    .mockResolvedValueOnce(gone(copyItem.id));
  vi.mocked(f.destination.remove).mockResolvedValueOnce({ ...refusal, reason: "timeout" });
  const answer = await transferPersonalEvent({
    source: { writer: f.source, connection, cal },
    destination: { writer: f.destination, connection, cal, markDue },
    transfer: {
      source: sourceItem.id,
      fields,
      progress: { phase: "verifying", id: copyItem.id, version: copyItem.version },
    },
    final: true,
    originalVersion: sourceItem.version,
    key: { hex: "a".repeat(32) },
    zones: intlZones(),
    signal,
    remember: async () => true,
  });
  expect(answer).toEqual(refusal);
  expect(f.source.remove).not.toHaveBeenCalled();
  expect(markDue).toHaveBeenCalledOnce();
});
