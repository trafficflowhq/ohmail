/** The parts a shell handed `writeEntry`, for every view of the screen under it. */
import { createContext, useContext } from "react";
import type { WriteParts } from "./ports.js";

export const WritePartsContext = createContext<WriteParts | null>(null);

export function useWriteParts(): WriteParts {
  const parts = useContext(WritePartsContext);
  if (parts === null) throw new Error("a part of write was drawn outside its entry");
  return parts;
}
