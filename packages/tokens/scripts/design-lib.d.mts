/** A source entry: the value, or the value with the sheet's note beside it. */
export type SourceEntry = string | { value: string; note?: string };
export type SourceBlock = Record<string, SourceEntry>;
/** source/tokens.json and source/motion.json as read. The generator checks the shape; a test may break it. */
export interface Source {
  tokens: Record<string, any>;
  motion: Record<string, any>;
  fonts: Record<string, any>;
}
export interface Block {
  path: string;
  when: Record<string, string>;
  order: number;
  decls: Record<string, string>;
}
export class SourceError extends Error {}
export function readSource(dir?: string): Source;
export function blocksOf(tokens: Source["tokens"]): Block[];
export function cascade(blocks: Block[], ctx: Record<string, string>): Record<string, string>;
export function resolveAll(map: Record<string, string>, extra?: Record<string, string>): Record<string, string>;
export function selectorOf(when: Record<string, string>, options?: { systemScheme?: boolean }): string;
export function valueOf(entry: SourceEntry): string;
