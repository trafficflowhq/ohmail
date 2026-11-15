/**
 * THE SCOPE: everything under it is mounted again when the account, mailbox or pairing changes, so that no
 * half-written letter, held send or pending delete of one scope is read, sent or deleted under another.
 * The scope is the host's, fixed for the life of a mounted frame.
 */
import { Fragment, type ReactNode } from "react";

export function Scoped({ scope, children }: { scope: string | null; children: ReactNode }) {
  return <Fragment key={scope ?? "nobody"}>{children}</Fragment>;
}
