import { describe, expect, it } from "vitest";
import { readQuickEntry } from "../../src/calendar/quick-entry.js";

const today = "2026-11-10";
const options = {
  today,
  zoneOf: (word: string) =>
    ["lisbon", "lissabon"].includes(word.toLowerCase()) ? "Europe/Lisbon" : undefined,
};

describe("typing a new calendar event", () => {
  it.each([
    [
      "lunch with Ben tomorrow 1pm",
      { title: "Lunch with Ben", day: "2026-11-11", from: 780, to: 840, guest: "Ben" },
    ],
    [
      "Mittagessen mit Ben morgen 13 Uhr",
      { title: "Mittagessen mit Ben", day: "2026-11-11", from: 780, to: 840, guest: "Ben" },
    ],
    ["dentist thu 9:30 for 75 min", { title: "Dentist", day: "2026-11-12", from: 570, to: 645 }],
    ["Zahnarzt Do 9.30", { title: "Zahnarzt", day: "2026-11-12", from: 570 }],
    ["Zahnarzt Do. 9.30", { title: "Zahnarzt", day: "2026-11-12", from: 570 }],
    ["So früh wie möglich morgen", { title: "So früh wie möglich", day: "2026-11-11" }],
    ["Do taxes friday", { title: "Do taxes", day: "2026-11-13" }],
    ["Zahnarzt Do 9.30 für 75 Min", { title: "Zahnarzt", day: "2026-11-12", from: 570, to: 645 }],
    [
      "Makersfest 20 nov to 22 nov in Zürich",
      { title: "Makersfest", day: "2026-11-20", endDay: "2026-11-22", allDay: true, place: "Zürich" },
    ],
    [
      "Makersfest 20.–22. Nov in Zürich",
      { title: "Makersfest", day: "2026-11-20", endDay: "2026-11-22", allDay: true, place: "Zürich" },
    ],
    [
      "run with Reto every thursday 7am",
      { title: "Run with Reto every thursday", day: "2026-11-12", from: 420, to: 480, guest: "Reto" },
    ],
    [
      "Laufen mit Reto jeden Donnerstag 7 Uhr",
      { title: "Laufen mit Reto jeden Donnerstag", day: "2026-11-12", from: 420, to: 480, guest: "Reto" },
    ],
    ["call Inês 3pm Lisbon", { title: "Call Inês", from: 900, to: 960, zone: "Europe/Lisbon" }],
    ["Anruf Inês 15 Uhr Lissabon", { title: "Anruf Inês", from: 900, to: 960, zone: "Europe/Lisbon" }],
    ["review in 2 weeks 10am", { title: "Review", day: "2026-11-24", from: 600, to: 660 }],
    ["Review in 2 Wochen 10 Uhr", { title: "Review", day: "2026-11-24", from: 600, to: 660 }],
    ["glaze test next friday 2-4pm", { title: "Glaze test", day: "2026-11-20", from: 840, to: 960 }],
    ["Glasurtest nächsten Freitag 14–16 Uhr", { title: "Glasurtest", day: "2026-11-20", from: 840, to: 960 }],
    [
      "Lea's birthday 26 nov every year",
      { title: "Lea's birthday every year", day: "2026-11-26", allDay: true },
    ],
    [
      "Leas Geburtstag 26. Nov jedes Jahr",
      { title: "Leas Geburtstag jedes Jahr", day: "2026-11-26", allDay: true },
    ],
    ["team lunch noon", { title: "Team lunch", from: 720, to: 780 }],
    ["Teamessen mittags", { title: "Teamessen", from: 720, to: 780 }],
    ["pizza friday after work", { title: "Pizza after work", day: "2026-11-13", allDay: true }],
    ["Pizza Freitag nach der Arbeit", { title: "Pizza nach der Arbeit", day: "2026-11-13", allDay: true }],
    ["flight at 6", { title: "Flight", from: 360, to: 420 }],
    ["Flug um 6", { title: "Flug", from: 360, to: 420 }],
    [
      "Meet tomorrow at 22:50 @ Upper hall alert 15 min",
      { title: "Meet", day: "2026-11-11", from: 1370, to: 1430, place: "Upper hall", alert: 15 },
    ],
    ["meet 12/11", { title: "Meet", day: "2026-11-12", allDay: true }],
  ] as const)("reads %s", (line, expected) => {
    expect(readQuickEntry(line, options)).toMatchObject(expected);
  });

  it.each([
    "Do homework",
    "Call in the morning",
    "Morgens im Büro halb zwei",
    "Meeting the Friday after",
    "First Monday of the month",
  ])("leaves unrecognized timing words in %s", (line) => {
    const result = readQuickEntry(line, options);
    expect(result?.day).toBeUndefined();
    expect(result?.from).toBeUndefined();
    expect(result?.title ?? line).toContain(line.includes("Büro") ? "halb zwei" : line);
  });

  it("marks exactly the parts of the line that fill fields", () => {
    const line = "Dentist thu 9:30 for 75 min";
    const result = readQuickEntry(line, options);
    expect(result?.marks.map(([from, to]) => line.slice(from, to))).toEqual(["thu", "9:30", "for 75 min"]);
  });
});
