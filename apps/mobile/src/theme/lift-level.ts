/**
 * The lift ladder's rungs, apart from `lift.ts`: the palette and the Ohmarchy face name a rung
 * without loading React Native's types, so a program that reads the palette (the sidecar's
 * tests reach it through the phone's state) keeps Node's timers.
 */
export type LiftLevel = "l0" | "l1" | "l2" | "l3" | "barEdge" | "sheetEdge";
