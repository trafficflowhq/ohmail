import { expect, it } from "vitest";
import { eventTimeOf, readerZones, resizeTime } from "@ohmail/app-logic/calendar";
import { checkedAct } from "../packages/services/src/calendar/writes.js";

it("validates the forward and inverse calendar resize as paired times", () => {
  const start = { kind: "instant", value: "20261116T100000Z" } as const;
  const end = { kind: "instant", value: "20261116T120000Z" } as const;
  const eventId = "18253f29-4da2-4ddb-89c5-6fbfb9dd8650";
  const patch = resizeTime(
    { id: eventId, start: eventTimeOf(start)!, end: eventTimeOf(end)! },
    "end",
    60,
    "Europe/Zurich",
    readerZones(),
  );
  const act = { kind: "calendar_event_update", eventId, scope: { kind: "record" } };
  expect(checkedAct({ ...act, base: "2026-11-16T09:00:00.000Z", change: patch })).toMatchObject({
    change: { start, end: { ...end, value: "20261116T130000Z" } },
  });
  const original = { start, end };
  const inverse = Object.fromEntries(
    Object.keys(patch!).map((key) => [key, original[key as keyof typeof original]]),
  );
  expect(checkedAct({ ...act, base: "2026-11-16T09:01:00.000Z", change: inverse })).toMatchObject({
    change: original,
  });
});
