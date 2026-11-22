import { useEffect, useRef, useState, type ReactNode } from "react";
import { SettingLine, SettingNote } from "@ohmail/ui/mail";

/**
 * A press that writes, as the shipped rows hold it: one write at a time, the switch shows the stored value, and a
 * refusal is said under its line until the next press. `run` answers when the server did and throws when it refused.
 */
export function useWrite(): {
  pending: boolean;
  failed: boolean;
  run: (write: () => Promise<unknown>) => void;
} {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = (write: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    void (async () => {
      try {
        await write();
      } catch {
        if (alive.current) setFailed(true);
      } finally {
        if (alive.current) setPending(false);
      }
    })();
  };
  return { pending, failed, run };
}

/** A switch over a stored value, its note under it, and its refusal when the last write was refused. */
export function WrittenSwitch(props: {
  readonly label: string;
  readonly on: boolean;
  /** It cannot be pressed for a reason of its own, beside a write in flight. */
  readonly held?: boolean;
  readonly note?: string | null;
  readonly info?: ReactNode;
  readonly failed: string;
  readonly set: (next: boolean) => Promise<unknown>;
}) {
  const write = useWrite();
  return (
    <>
      <SettingLine
        label={props.label}
        info={props.info}
        toggle={{ on: props.on, onChange: (next) => write.run(() => props.set(next)) }}
        off={write.pending || props.held === true}
      />
      {props.note ? <SettingNote>{props.note}</SettingNote> : null}
      {write.failed ? <SettingNote warn>{props.failed}</SettingNote> : null}
    </>
  );
}
