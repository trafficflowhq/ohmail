"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NONE, type ConnectFormInput, type SignInCalls } from "./calls.js";
import { reasonCodeOf, saidOf, saidOfReturn } from "./refusal.js";
import { deviceSignInFailureKey, deviceSignInRefusalCode, PRESET_OF_SIGN_IN, WAYS_SHUT } from "./sign-in.js";
import type { Answered, CodeCeremony, SignInProvider, SignInReturn, SignInWays } from "./types.js";
import { NO_ANSWER, type Machine } from "./use-machine.js";

const nothing = { subscribe: (): (() => void) => () => undefined, read: (): null => null };

/** The ceremonies this shell runs: shut until read, and shut when the read fails. Read once per wire. */
export function useWays(signIn: SignInCalls | "none"): SignInWays {
  const [ways, setWays] = useState<SignInWays>(WAYS_SHUT);
  useEffect(() => {
    if (signIn === NONE) return;
    let wanted = true;
    void signIn.ways().then(
      (read) => {
        if (wanted) setWays(read);
      },
      () => undefined,
    );
    return () => {
      wanted = false;
    };
  }, [signIn]);
  return ways;
}

/**
 * A SIGN-IN THAT CAME BACK WITH NOTHING CONNECTED is said where its landing is this form: the join. Elsewhere the
 * landing is the Mailboxes pane, which draws it. Once per return, and it presses nothing: a refused sign-in is
 * started again only by the person.
 */
export function useSignInReturn(input: ConnectFormInput, machine: Machine): boolean {
  const signIn = input.door.signIn;
  const returned: SignInReturn | null = useSyncExternalStore(
    signIn === NONE ? nothing.subscribe : signIn.returned.subscribe,
    signIn === NONE ? nothing.read : signIn.returned.read,
    nothing.read,
  );
  const said = useRef<SignInReturn | null>(null);
  const { purpose } = input;
  const { dispatch } = machine;
  useEffect(() => {
    if (purpose !== "join" || returned === null || said.current === returned) return;
    said.current = returned;
    if (returned.kind !== "refused" && returned.kind !== "failed") return;
    dispatch({ kind: "provider", id: PRESET_OF_SIGN_IN.microsoft, byHand: true });
    dispatch({ kind: "said", shown: saidOfReturn(returned, purpose), reason: returned.reason });
  }, [purpose, returned, dispatch]);
  return purpose === "join" && (returned?.kind === "refused" || returned?.kind === "failed");
}

export interface SignInPress {
  /** The press is on its way to the shell. */
  readonly signingIn: boolean;
  /** A sign-in by code, as the shell says to draw it. */
  readonly code: CodeCeremony | null;
  signIn(): void;
  stopCode(): void;
}

/**
 * THE SIGN-IN'S ONE PRESS. Whose browser this is first; then the shell leaves for the provider, or begins a sign-in
 * by code. The shell holds the ceremony whole: this keeps no state, no code and no handle of it. A press overtaken
 * by a new choice is retired: `stillWanted` says so to the shell, which then records nothing and leaves nowhere.
 * `instead`: the tile's own sign-in while the password way stands taken on it, for the press beside a refused password.
 */
export function useSignInPress(
  input: ConnectFormInput,
  machine: Machine,
  way: { readonly provider: SignInProvider; readonly by: "redirect" | "code" } | null,
  instead: { readonly provider: SignInProvider; readonly by: "redirect" | "code" } | null = null,
): SignInPress {
  const { door, purpose, subject, guard } = input;
  const { held, alive, dispatch } = machine;
  const [signingIn, setSigningIn] = useState(false);
  const [watchingCode, setWatchingCode] = useState(false);
  const edits = purpose === "edit" || purpose === "reconnect";
  /* The Mailboxes list can take over a new sign-in. An inline form only watches one it started itself. */
  const codeDoor =
    watchingCode && door.signIn !== NONE && door.signIn.code !== NONE ? door.signIn.code : null;
  const code: CodeCeremony | null = useSyncExternalStore(
    codeDoor?.live.subscribe ?? nothing.subscribe,
    codeDoor?.live.read ?? nothing.read,
    nothing.read,
  );

  useEffect(() => {
    if (code?.kind !== "connected" || codeDoor === null || codeDoor.live.read() !== code) return;
    codeDoor.stop();
    setWatchingCode(false);
    input.onDone({ kind: "connected", ...code.connected, created: code.created });
  }, [code, codeDoor, input]);

  const signIn = (): void => {
    const wire = door.signIn;
    const by = way ?? instead;
    if (by === null || wire === NONE || signingIn) return;
    const device = by.by === "code" && wire.code !== NONE ? wire.code : null;
    dispatch({ kind: "signIn", at: "pressed" });
    const mine = held.current.signIns;
    const wanted = (): boolean => alive.current && held.current.signIns === mine;
    setSigningIn(true);
    void (async () => {
      let answer: Answered<unknown> = { ok: true, value: "retired" };
      try {
        if (guard && !(await guard.before())) return;
        if (!wanted()) return;
        answer =
          device !== null
            ? await device.begin(by.provider, wanted)
            : await wire.start({
                provider: by.provider,
                purpose,
                ...(edits && subject !== null ? { mailboxId: subject.id } : {}),
                stillWanted: wanted,
              });
      } catch {
        answer = { ok: false, refusal: NO_ANSWER };
      } finally {
        if (alive.current) setSigningIn(false);
      }
      if (!wanted()) return;
      if (answer.ok) {
        if (answer.value === "leaving") dispatch({ kind: "signIn", at: "leaving" });
        if (answer.value === null) {
          if (input.onCodeStarted) input.onCodeStarted();
          else setWatchingCode(true);
        }
        return;
      }
      if (device !== null) {
        const code = deviceSignInRefusalCode(answer.refusal.code);
        dispatch({
          kind: "said",
          shown: { said: { ns: "mailboxes", key: deviceSignInFailureKey(code) }, calm: false },
          reason: code,
        });
        return;
      }
      const context = {
        purpose,
        preset: null,
        manual: false,
        ports: false,
        signInArmed: true,
        afterFactor: false,
        factor: false,
      };
      dispatch({
        kind: "said",
        shown: { said: saidOf(answer.refusal, context), calm: false },
        reason: reasonCodeOf(answer.refusal),
      });
    })();
  };

  return {
    signingIn,
    code,
    signIn,
    stopCode: () => {
      codeDoor?.stop();
      setWatchingCode(false);
    },
  };
}
