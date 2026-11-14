/**
 * The invented world the mail parts are drawn on, as the reference shows it: who writes, what they
 * write about, how far each conversation is read. Addresses are on `.example`.
 */
import { squaresWindow } from "../../../../src/squares-window.js";
import type { RowPerson, SquareKind, SquaresRun } from "../../../../src/mail/index.js";

export const person = (name: string, address: string): RowPerson => ({ name, address });

export const ME = person("Mila Brunner", "mila@lichtgrat.example");
export const PETRA = person("Petra Wyss", "petra@makersfest.example");
export const NADJA = person("Nadja Lehner", "nadja@erdton-atelier.example");
export const LEA = person("Lea Brunner", "lea@brunner-familie.example");
export const CARLA = person("Carla Meier", "carla@wintermarkt-lind.example");
export const GIULIA = person("Giulia Ferrari", "giulia@terracotta-milano.example");
export const BEN = person("Ben Arnold", "ben@lichtgrat.example");
export const TIM = person("Tim Berger", "tim@gassenblatt.example");
export const JONAS = person("Jonas Halter", "jonas@lichtgrat.example");
export const TOBIAS = person("Tobias Frei", "tobias@lichtgrat.example");
export const RAHEL = person("Rahel Beck", "rahel@lichtgrat.example");
export const RETO = person("Reto Frei", "reto@alpmail.example");
export const HOSTWERK = person("Hostwerk", "support@hostwerk.example");
export const ERDTON = person("Atelier Erdton", "billing@erdton-atelier.example");

/** A conversation of five: two not seen yet. */
export const GLAZE: SquareKind[] = ["own", "seen", "own", "unseen", "unseen"];
/** A conversation of twelve: the last four not seen yet. */
export const KILN: SquareKind[] = [
  "seen",
  "own",
  "seen",
  "seen",
  "seen",
  "seen",
  "own",
  "seen",
  "unseen",
  "unseen",
  "unseen",
  "unseen",
];
/** A conversation of thirty, all seen. */
export const STUDIO: SquareKind[] = Array.from({ length: 30 }, (_, i): SquareKind =>
  [1, 5, 9, 13, 15, 17, 21, 25].includes(i) ? "own" : "seen",
);
export const PHOTOS: SquareKind[] = ["seen", "seen", "own", "seen"];

/** The run that stands in a row's label: nine squares' room and the count's slot. */
export const rowRun = (n: number, current: number, slots = 9): SquaresRun =>
  squaresWindow({ n, current, room: slots * 12 + 26, pitch: 12, count: 26 });
/** The run that stands upright in a column `room` high. */
export const columnRun = (n: number, current: number, room: number): SquaresRun => ({
  ...squaresWindow({ n, current, room, pitch: 18, count: 16 }),
  room,
});
