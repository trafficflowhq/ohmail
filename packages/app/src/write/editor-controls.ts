/** The marks an editor may offer. An editor names the ones it has; the strip draws those alone. */
export type MarkId =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "link"
  | "bullets"
  | "numbers"
  | "quote"
  | "code"
  | "codeBlock"
  | "divider";

export type ParagraphStyle = 0 | 1 | 2 | 3;

export interface EditorMarks {
  readonly ids: readonly MarkId[];
  readonly shortcuts?: Partial<Record<MarkId, readonly string[]>>;
  /** The marks that hold where the caret is now. */
  active(): ReadonlySet<MarkId>;
  /** Called when `active()` may answer otherwise; the return stops it. */
  subscribe(changed: () => void): () => void;
  run(id: MarkId): void;
  readonly paragraph?: {
    active(): ParagraphStyle | null;
    set(style: ParagraphStyle): void;
  };
  readonly link: {
    /** Capture the range before focus leaves the editor. */
    open(): EditorLink;
    /** Mod+K in the text: `ask` is called as a press on the strip's Link is; the return stops it. */
    onKey(ask: () => void): () => void;
  };
}

export interface EditorLink {
  readonly href: string | null;
  set(href: string | null): "ok" | "refused";
  restore(): void;
}
