/** One row of `test/reference/<entry>/states.json`: a state of a component, and the looks it is compared in. */
export interface StateRow {
  component: string;
  state: string;
  /** `"all"` for the component's rest state; otherwise the look ids, the baseline when left out. */
  looks?: "all" | string[];
}

export const LOOKS: string[];
export const BASELINE: string;
export function stateKey(row: Pick<StateRow, "component" | "state">): string;
export function looksOf(row: Pick<StateRow, "looks">): string[];
export function referenceKey(row: Pick<StateRow, "component" | "state">, look: string): string;
export function stateHash(row: StateRow): string;
export function fileOf(key: string): string;
export const PRIVATE: RegExp;
