/** The parts a shell handed `readerEntry`, for every view of the reader under it. */
import { createContext, useContext } from "react";
import type { ReaderParts } from "./ports.js";

export const PartsContext = createContext<ReaderParts | null>(null);

export function useParts(): ReaderParts {
  const parts = useContext(PartsContext);
  if (parts === null) throw new Error("a part of the reader was drawn outside its entry");
  return parts;
}
