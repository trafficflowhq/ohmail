/**
 * The join's second factor and its recovery codes. A passkey first; an authenticator app where this device cannot make
 * one: its picture (the shell's), its key to read off or copy, and its first code. Then the ten codes, shown once.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Menu, MenuItem, Page, RadioLines, RefusalLine, Slot } from "@ohmail/ui/base";
import { DoorSheet } from "../stage/DoorSheet.js";
import { DoorFields, DoorForm } from "../stage/DoorForm.js";
import { Said, SaidWith } from "../stage/Said.js";
import { SentenceBlank } from "../stage/SentenceBlank.js";
import type { JoinState } from "./door.js";
import { refusalOf, SignOutAgain, type StepProps } from "./parts.js";

/** A base32 key in groups of four, as authenticator apps print it; Copy takes it whole. */
function grouped(key: string): string {
  return (
    key
      .replace(/\s+/g, "")
      .match(/.{1,4}/g)
      ?.join(" ") ?? key
  );
}

/** An authenticator's code is six digits: anything else typed is dropped as it is typed. */
const CODE_LENGTH = 6;
const digitsOf = (typed: string): string => typed.replace(/\D/g, "").slice(0, CODE_LENGTH);

export function FactorStep(p: StepProps<"factor">): ReactNode {
  const { door, state, join, progress } = p;
  const { pending, busy } = door;
  if (state.authenticator !== null) return <AuthenticatorStep {...p} authenticator={state.authenticator} />;
  return (
    <Page
      aside={progress}
      refusal={refusalOf(pending, door.refusal)}
      columns={2}
      material={
        <DoorSheet kind="facts">
          <div inert={busy}>
            <RadioLines<"passkey" | "app">
              label={join("factorLabel")}
              value="passkey"
              kind="sheet"
              options={[
                { value: "passkey", label: join("factorPasskey") },
                { value: "app", label: join("factorApp"), tag: join("factorTag") },
              ]}
              onChange={(choice) => {
                if (!busy && choice === "app") door.useAuthenticator();
              }}
            />
          </div>
        </DoorSheet>
      }
      acts={
        <>
          <Button size="l" disabled={busy} onPress={door.addPasskey}>
            {busy ? join("working") : join("addPasskey")}
          </Button>
          <SignOutAgain pending={pending} busy={busy} />
        </>
      }
    >
      <FactorSentence {...p} />
    </Page>
  );
}

function FactorSentence({ door, join, state }: StepProps<"factor">): ReactNode {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const app = state.authenticator !== null;
  const label = join("factorLabel");
  const choose = (useApp: boolean): void => {
    setOpen(false);
    if (app !== useApp && !door.busy) {
      if (useApp) door.useAuthenticator();
      else door.leaveAuthenticator();
    }
  };
  return (
    <>
      <SaidWith
        level={1}
        parts={join.rich(app ? "lockWithApp" : "lockWith", {
          how: () => (
            <Slot ref={anchor} disabled={door.busy} expanded={open} onPress={() => setOpen(!open)}>
              {join(app ? "factorAppWord" : "factorPasskeyWord")}
            </Slot>
          ),
        })}
      />
      <Menu anchor={anchor} open={open} label={label} onClose={() => setOpen(false)}>
        <MenuItem checked={!app} onPress={() => choose(false)}>
          {join("factorPasskey")}
        </MenuItem>
        <MenuItem checked={app} onPress={() => choose(true)}>
          {join("factorApp")}
        </MenuItem>
      </Menu>
    </>
  );
}

type Authenticator = NonNullable<Extract<JoinState, { at: "factor" }>["authenticator"]>;

/** The authenticator: scan or type the key, then its first code. A refused code is said under the code it is about. */
function AuthenticatorStep(p: StepProps<"factor"> & { authenticator: Authenticator }): ReactNode {
  const { door, join, progress, authenticator } = p;
  const { pending, busy, fields } = door;
  const code = useRef<HTMLInputElement>(null);
  /* The code is the step's one blank: it takes the focus on arrival, and again when its code is refused. */
  useEffect(() => {
    code.current?.focus();
  }, [door.refusal]);
  return (
    <DoorForm onSubmit={door.activate}>
      <Page
        aside={progress}
        refusal={refusalOf(pending, null)}
        columns={2}
        material={
          <DoorFields>
            <div className="way-join-qr">{door.slots.authenticatorQr()}</div>
            <p className="way-join-key">
              <code className="way-join-key-value">{grouped(authenticator.key)}</code>
            </p>
            <span className="way-join-row">
              <Button kind="two" size="s" onPress={door.copyKey}>
                {authenticator.copied === "copied" ? join("totpCopied") : join("totpCopy")}
              </Button>
              <Button kind="quiet" size="s" onPress={door.openAuthenticator}>
                {join("totpOpenApp")}
              </Button>
            </span>
            {authenticator.copied === "failed" ? (
              <p className="way-join-status" role="status">
                {join("totpCopyFailed")}
              </p>
            ) : null}
          </DoorFields>
        }
        acts={
          <>
            <Button type="submit" size="l" keyHint="↵" disabled={busy || fields.otp.length !== CODE_LENGTH}>
              {busy ? join("working") : join("activate")}
            </Button>
            <SignOutAgain pending={pending} busy={busy} />
          </>
        }
      >
        <FactorSentence {...p} />
        <SaidWith
          parts={join.rich("codeIs", {
            blank: () => (
              <SentenceBlank
                ref={code}
                id="join-totp"
                describedBy={door.refusal === null ? undefined : "join-totp-refusal"}
                label={join("totpLabel")}
                placeholder={join("totpBlank")}
                autoComplete="one-time-code"
                inputMode="numeric"
                refused={door.refusal !== null}
                value={fields.otp}
                onChange={(v) => door.type("otp", digitsOf(v))}
              />
            ),
          })}
        />
        {door.refusal === null ? null : (
          <RefusalLine
            alert
            start
            ref={(line) => {
              if (line) line.id = "join-totp-refusal";
            }}
          >
            {door.refusal}
          </RefusalLine>
        )}
      </Page>
    </DoorForm>
  );
}

/**
 * The ten recovery codes, shown once: copied, downloaded or written down, then said to be kept before the setup goes
 * on. Codes this account already has (another tab made them) are never made again here.
 */
export function CodesStep({ door, state, join, progress }: StepProps<"codes">): ReactNode {
  const { pending, busy } = door;
  const { codes } = state;
  const own = (material: ReactNode, acts: ReactNode): ReactNode => (
    <Page
      aside={progress}
      refusal={refusalOf(pending, door.refusal)}
      material={material}
      acts={
        <>
          {acts}
          <SignOutAgain pending={pending} busy={busy} />
        </>
      }
    >
      <Said text={join("step_codes_title")} level={1} />
    </Page>
  );
  if (codes === "elsewhere")
    return own(
      <p className="way-join-status" role="status">
        {join("codesElsewhere")}
      </p>,
      <Button size="l" onPress={door.codesDone}>
        {join("continue")}
      </Button>,
    );
  if (codes === "failed")
    return own(
      undefined,
      <Button size="l" onPress={door.retryCodes}>
        {join("codesRetry")}
      </Button>,
    );
  if (codes === "making")
    return own(
      <p className="way-join-status" role="status">
        {join("working")}
      </p>,
      null,
    );
  return own(
    <DoorFields>
      <ul className="way-join-codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <span className="way-join-row">
        <Button kind="two" size="s" onPress={door.copyCodes}>
          {state.copied === "copied" ? join("codesCopied") : join("codesCopy")}
        </Button>
        <Button kind="quiet" size="s" onPress={door.downloadCodes}>
          {join("codesDownload")}
        </Button>
      </span>
      {state.copied === "failed" ? (
        <p className="way-join-status" role="status">
          {join("codesCopyFailed")}
        </p>
      ) : null}
    </DoorFields>,
    <Button
      size="l"
      onPress={() => {
        door.save(true);
        door.codesDone();
      }}
    >
      {join("codesSaved")}
    </Button>,
  );
}
