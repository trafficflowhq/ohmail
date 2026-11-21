/**
 * THE SCOPE: everything under it is mounted again when the account, mailbox or pairing changes, so that no
 * half-written letter, held send or pending delete of one scope is read, sent or deleted under another.
 * The scope is the host's, fixed for the life of a mounted frame.
 *
 * Under a scope that names nobody (`scopeMayMount`: none, an empty one, `local`, `anon`, a shape no id has) nothing
 * mounts: no place's body, no stage, no rail, no notice part. Each host has its own screen for that state.
 *
 * What stands under it can read which scope that is (`useScopeHere`): the one mount of the scope is also its one
 * provider, so a part never looks an owner up.
 */
import { createContext, useContext, type ReactNode } from "react";
import { scopeMayMount } from "@ohmail/app-logic/storage/scope";

const ScopeHere = createContext<string | null>(null);

export function Scoped({ scope, children }: { scope: string | null; children?: ReactNode }) {
  if (!scopeMayMount(scope)) return null;
  return (
    <ScopeHere.Provider key={scope} value={scope}>
      {children}
    </ScopeHere.Provider>
  );
}

/**
 * THE SCOPE A PART IS DRAWN UNDER, for a part that keeps a choice per account and is also drawn where no frame
 * stands (a form or a row mounted by itself): the frame's scope under a frame, null where no scope stands above.
 * Under null such a part names no stored key: it reads none and writes none. It is never a scope that defaults. A
 * place and a piece of the ground always stand under a frame and read `useFrame().host.session.scope`.
 */
export function useScopeHere(): string | null {
  return useContext(ScopeHere);
}
