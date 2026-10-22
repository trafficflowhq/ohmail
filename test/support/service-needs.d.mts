/** Which test services a test file needs; the rules are stated in `service-needs.mjs`. */

export type ServiceName = "pg" | "greenmail" | "dovecot" | "rustfs";
export const SERVICES: ServiceName[];
export const SERVICE_GATE_PREFIX: string;
export interface Classified { needs: ServiceName[]; gated: ServiceName[]; gate: ServiceName[] }
export function markersOf(raw: string, rel?: string): { none: boolean; add: ServiceName[] };
export function ownSignals(raw: string, rel?: string): { src: string; needs: Set<ServiceName>; gated: Set<ServiceName> };
export function relativeImports(src: string, rel: string, root: string): string[];
export function classify(rel: string, root: string, memo?: Map<string, Set<string>>): Classified;
export function classifyPath(abs: string, root: string, memo?: Map<string, Set<string>>): Classified;
export function homeMadeProbe(raw: string): string | null;
