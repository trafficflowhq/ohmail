/**
 * The join's second factor and its recovery codes. A passkey first; an authenticator app where this device cannot make
 * one: its picture (the shell's), its key to read off or copy, and its first code. Then the ten codes, shown once.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Button, Field, Page, Switch } from "@ohmail/ui/base";
import { DoorFields, DoorForm } from "../stage/DoorForm.js";
import { Said } from "../stage/Said.js";
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
      line={join("step_factor_lead")}
      note={join("passkeyNote")}
      acts={
        <>
          <Button size="l" disabled={busy} onPress={door.addPasskey}>
            {busy ? join("working") : join("addPasskey")}
          </Button>
          <Button kind="quiet" size="l" disabled={busy} onPress={door.useAuthenticator}>
            {join("useTotp")}
          </Button>
          <SignOutAgain pending={pending} busy={busy} />
        </>
      }
    >
      <Said text={join("step_factor_title")} level={1} />
    </Page>
  );
}

type Authenticator = NonNullable<Extract<JoinState, { at: "factor" }>["authenticator"]>;

/** The authenticator: scan or type the key, then its first code. A refused code is said under the code it is about. */
function AuthenticatorStep(p: StepProps<"factor"> & { authenticator: Authenticator }): ReactNode {
  const { door, join, progress, authenticator } = p;
  const { pending, busy, fields } = door;
  const code = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
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
              <code>{grouped(authenticator.key)}</code>
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
            {/* The card's id, and its number pad: an authenticator's code is six digits. */}
            <Field
              ref={code}
              id="join-totp"
              label={join("totpLabel")}
              autoComplete="one-time-code"
              inputMode="numeric"
              refusal={door.refusal ?? undefined}
              value={fields.otp}
              onChange={(v) => door.type("otp", digitsOf(v))}
            />
          </DoorFields>
        }
        line={join("totpScan")}
        acts={
          <>
            <Button type="submit" size="l" keyHint="↵" disabled={busy || fields.otp.length !== CODE_LENGTH}>
              {busy ? join("working") : join("activate")}
            </Button>
            <Button kind="quiet" size="l" onPress={door.leaveAuthenticator}>
              {join("back")}
            </Button>
            <SignOutAgain pending={pending} busy={busy} />
          </>
        }
      >
        <Said text={join("step_factor_title")} level={1} />
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
      line={join("step_codes_lead")}
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
      <Switch label={join("codesConfirm")} labelled on={state.saved} onChange={door.save} />
    </DoorFields>,
    <Button size="l" disabled={!state.saved} onPress={door.codesDone}>
      {join("continue")}
    </Button>,
  );
}
