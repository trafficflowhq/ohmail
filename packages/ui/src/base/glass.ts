/**
 * What a host that knows the glass writes on the page's root, by these names, for the kit's fixed parts: how much
 * the system draws over at the glass's foot (0 while a keyboard is up, which covers it), and how high a keyboard
 * stands. The kit's root reads both (`--oh-inset-foot`, `--oh-inset-keys` in `base.css`); without a host it reads
 * what the system itself reports.
 */
export const GLASS = { foot: "--sys-b", keys: "--kb" } as const;
