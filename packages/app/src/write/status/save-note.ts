/**
 * WHETHER THE LETTER IS KEPT, SAID: a person's unsent words that are in no Drafts are said to be so, in the letter's
 * note, in this order of rank: the composition's own refusal to close (Escape over words nothing holds keeps the
 * letter open, and says why) while it stands; the ceiling's sentence while the words are too long to save (drawn by
 * `useOverLimit`'s line, between the two); the account's refusal to keep the draft (said only where the ceiling does
 * not already say why); the note that this is the letter left unfinished last time. Today's composer said each.
 * Over a letter whose row went elsewhere, its own line (`elsewhere.ts`) speaks first, and these give way as today's did.
 */
export interface SaveState {
  /** The composition's sentence while it refuses to close the letter. */
  readonly closeRefusal: string | null;
  /** The words are past the save ceiling: its own line says so. */
  readonly ceiling: boolean;
  /** The account refused to keep the draft. */
  readonly saveRefused: boolean;
  /** The letter came back from the last session. */
  readonly resumed: boolean;
  /**
   * The letter's row went elsewhere (sent, deleted or changed on another device: its own line says so), and whether
   * words were typed here since. Over a letter that went, the resumed note is not said, and the account's refusal is
   * said only of words typed since (they are a new draft of their own), as today's composer said them.
   */
  readonly elsewhere: "none" | "typed" | "untyped";
}

/** The draft can carry the usual saving message when no refusal is standing. */
export function canReassure(s: SaveState): boolean {
  return s.closeRefusal === null && !s.ceiling && !s.saveRefused && s.elsewhere !== "untyped";
}

/** The lines before the ceiling's, and after it, in the order of rank. */
export function saveLines(
  s: SaveState,
  words: { readonly notSaved: string; readonly resumed: string; readonly saved?: string },
): { readonly before: readonly string[]; readonly after: readonly string[] } {
  return {
    before: s.closeRefusal === null ? [] : [s.closeRefusal],
    after: [
      ...(s.saveRefused && !s.ceiling && s.elsewhere !== "untyped" ? [words.notSaved] : []),
      ...(canReassure(s) && words.saved !== undefined ? [words.saved] : []),
      ...(s.resumed && s.elsewhere === "none" ? [words.resumed] : []),
    ],
  };
}
