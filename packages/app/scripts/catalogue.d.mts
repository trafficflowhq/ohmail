export declare const ROOT: string;
export declare const LANGS: readonly ["en", "de"];
export declare function blocksOf(text: string, where: string): { name: string; text: string }[];
export declare function fileOf(blocks: readonly { text: string }[]): string;
export declare function assemble(root?: string): {
  aggregates: Record<string, string>;
  order: string[];
  problems: string[];
};
export declare function check(root?: string): string[];
export declare function write(root?: string): string[];
export declare function prove(commit: string, root?: string): { ok: boolean; lines: string[] };
export declare function cut(root?: string): void;
