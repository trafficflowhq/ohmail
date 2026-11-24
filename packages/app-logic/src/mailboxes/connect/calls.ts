/**
 * WHAT THE CONNECT FORM'S HOOKS CALL AND ARE HANDED. A shell's connect wire answers {@link ConnectCalls} by
 * structure; every member answers and none throws.
 */
import type { ConnectFacts, ConnectOutcome } from "./state.js";
import type { Secret } from "./secret.js";
import type {
  Answered,
  CodeCeremony,
  Connected,
  ConnectInput,
  ConnectKept,
  ConnectPatch,
  ConnectProbed,
  ConnectPurposeKind,
  MailboxId,
  SignInProvider,
  SignInReturn,
  SignInWays,
} from "./types.js";

export type None = "none";
export const NONE: None = "none";

/** What changes while the form stands: read it now, and be told when to read again. */
export interface Watched<T> {
  read(): T;
  subscribe(changed: () => void): () => void;
}

/** A provider's own sign-in, the shell's whole. */
export interface SignInCalls {
  ways(): Promise<SignInWays>;
  start(o: {
    provider: SignInProvider;
    purpose: ConnectPurposeKind;
    mailboxId?: MailboxId;
    stillWanted: () => boolean;
  }): Promise<Answered<"leaving" | "retired">>;
  readonly returned: Watched<SignInReturn | null>;
  readonly code:
    | {
        begin(provider: SignInProvider, stillWanted?: () => boolean): Promise<Answered<null>>;
        readonly live: Watched<CodeCeremony | null>;
        stop(): void;
      }
    | None;
}

export interface ConnectCalls {
  /** `none`: this shell has no test, and the form draws no test press. */
  readonly probe: ((input: ConnectInput) => Promise<Answered<ConnectProbed>>) | None;
  connect(input: ConnectInput, mode: "seed" | "add"): Promise<Answered<Connected>>;
  readonly edit: ((mailboxId: MailboxId, patch: ConnectPatch) => Promise<Answered<null>>) | None;
  readonly discover: ((domain: string, signal: AbortSignal) => Promise<unknown>) | None;
  readonly signIn: SignInCalls | None;
  readonly localServerWait: boolean;
  /** The door accepts a manual incoming server without an outgoing one. */
  readonly incomingOnly?: true;
}

/** The password field's own handle: the seal of what it holds, and forgetting it. The string never leaves the field. */
export interface PasswordHandle {
  take(): Secret;
  clear(): void;
}

export interface ConnectFormInput {
  readonly purpose: ConnectPurposeKind;
  readonly subject: ConnectFacts["subject"];
  readonly door: ConnectCalls;
  /** The second factor's dialog can be asked. */
  readonly factor: boolean;
  readonly kept?: ConnectKept | undefined;
  /** Whose browser this is: asked before a press leaves; its sentence goes with a press that changes the way in. */
  readonly guard?: { before(): Promise<boolean>; clear(): void } | undefined;
  onDone(outcome: ConnectOutcome): void;
  onCodeStarted?(): void;
}
