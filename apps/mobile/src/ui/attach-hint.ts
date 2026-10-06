/**
 * Where the composer's "Up to … total" hint stands. Beside the attach buttons it ends the row on the
 * right; when the row is too narrow it wraps, and a lone right-aligned fragment under the buttons
 * read as a stray (353 dp). Wrapped, it starts the next line on the left, under the buttons it
 * explains. `y` is the hint's top inside the wrapping row, from its own layout.
 */
export const attachHintWrapped = (y: number): boolean => y > 4;

/** Only the margin moves, never the hint's size, so the wrap the row decides stays the same wrap. */
export function attachHintStyle(wrapped: boolean): { marginLeft: "auto" | 0 } {
  return wrapped ? { marginLeft: 0 } : { marginLeft: "auto" };
}
