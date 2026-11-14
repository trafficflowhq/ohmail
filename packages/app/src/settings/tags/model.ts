/**
 * Tags' model: the account's tags as the mirror holds them, the colours the server accepts, and the four engine
 * verbs. The shell builds it; a tag's colour name is turned into its hue there, so the pane draws numbers only.
 */
export interface TagsModelTag {
  readonly id: string;
  readonly name: string;
  /** Its colour's name, one of `colours`. */
  readonly colour: string;
  readonly hue: number;
  /** How many of the messages this device holds carry it: a floor while the mirror fills. */
  readonly count: number;
}

export interface TagsModel {
  readonly tags: readonly TagsModelTag[];
  /** Every colour a tag can take: its name (a `settings.hue_<name>` word) and its hue. */
  readonly colours: readonly { readonly id: string; readonly hue: number }[];
  /** The hue a new tag is made in (the server's default). */
  readonly newHue: number;
  /** The sentence that a tag lives in ohmail, not in the mailbox: the tag place's own words. */
  readonly notOnServer: string;
  /** Withheld where a shell wires no tag verbs: the list is drawn and nothing acts. */
  readonly verbs: {
    create(name: string): void;
    rename(tagId: string, name: string): void;
    recolour(tagId: string, colour: string): void;
    remove(tagId: string): void;
  } | null;
}

/**
 * The name a new tag may take, or why not. Empty is nothing to make; a name the account already holds, in any case,
 * is refused before the write, because the server's unique index is on the lower-cased name and would answer 409.
 */
export function newTagName(
  tags: readonly Pick<TagsModelTag, "name">[],
  draft: string,
): { name: string; taken: boolean } | null {
  const name = draft.trim();
  if (name === "") return null;
  return { name, taken: tags.some((tag) => tag.name.toLowerCase() === name.toLowerCase()) };
}

/** A rename saves only a name that is there and is not the one it has: a Save that does nothing would say it acted. */
export function renamed(tag: TagsModelTag, draft: string): string | null {
  const next = draft.trim();
  return next.length > 0 && next !== tag.name ? next : null;
}
