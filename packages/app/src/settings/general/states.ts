/**
 * General's registered states, as models: the states page draws each over the fake host by its address
 * (`screen=settings&sec=general`). Verbs do nothing; a state is a picture of one moment.
 */
import type { GeneralModel, LookFace } from "./model.js";

const still = () => undefined;
const kept = () => Promise.resolve();

export function generalState(at: { face?: LookFace; scheme?: "light" | "dark" } = {}): GeneralModel {
  return {
    language: { value: "en", choices: ["en", "de"], local: false, busy: false, set: kept },
    theme: { value: at.scheme === "dark" ? "dark" : "light", set: still },
    look: { face: at.face ?? "paper", scheme: at.scheme ?? "light", set: still, scope: { governs: "all" } },
    textSize: { value: 100, choices: [90, 100, 110, 125, 150], set: still },
    imageQuality: { value: "medium", choices: ["low", "medium", "high", "original"], set: still },
    afterVerb: { value: "advance", choices: ["advance", "stay", "close"], set: still },
    images: { blocked: false, fromComputer: false, set: kept },
    pixels: { blocked: true, fromComputer: false, set: kept },
    defaultMail: null,
  };
}

/** The registry's General states by their `state=` word ("" is the section at rest). */
export const GENERAL_STATES: Readonly<Record<string, () => GeneralModel>> = {
  "": () => generalState(),
};
