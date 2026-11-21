/**
 * STRIP COMMENTS BEFORE ASKING WHAT THE CODE SAYS.
 *
 * The census below asserts that neither mount spells the chips itself. Read against raw source
 * that is answerable by PROSE: every one of these files documents the block it mounts, so a
 * comment saying `"rcpt-chip"` fails a passing file, and — the direction that actually costs
 * something — a file could keep a forked implementation alive inside a block comment and the
 * census would never tell them apart. Review named this exact defect. Line comments and block
 * comments go; string literals stay, because a class name in JSX IS a string literal and is the
 * thing being asked about.
 */
export function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}
