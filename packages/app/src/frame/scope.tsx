/**
 * THE SCOPE: everything under it is mounted again when the account, mailbox or pairing changes, so that no
 * half-written letter, held send or pending delete of one scope is read, sent or deleted under another.
 * The scope is the host's, fixed for the life of a mounted frame.
 *
 * Under a scope that names nobody (`scopeMayMount`: none, an empty one, `local`, `anon`, a shape no id has) nothing
 * mounts: no place's body, no stage, no rail, no notice part. Each host has its own screen for that state.
 */
import { Fragment, type ReactNode } from "react";
import { scopeMayMount } from "@ohmail/app-logic/storage/scope";

export function Scoped({ scope, children }: { scope: string | null; children: ReactNode }) {
  if (!scopeMayMount(scope)) return null;
  return <Fragment key={scope}>{children}</Fragment>;
}
