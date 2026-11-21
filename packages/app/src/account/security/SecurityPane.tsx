import { useState } from "react";
import { Button, Dialog, Field } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet, type SettingsSheetProps } from "@ohmail/ui/mail";
import { browserClipboard } from "../../host/browser/index.js";
import { useText, type Text } from "../../text/index.js";
import { ACCOUNT_REFUSALS, type FactorSlot } from "../contract.js";
import type { GatedRefusal } from "../gated.js";
import type { SecurityModel } from "./model.js";

export interface SecurityPaneProps {
  readonly model: SecurityModel;
  /** The factor's dialog, filled by the shell: drawn while a verb is parked behind it. */
  readonly factor: FactorSlot;
}

type Wants = NonNullable<SettingsSheetProps["wants"]>;

/** What a sheet wants, with its line only where there is one to say. */
const wants = (word: string, line: string): Wants => (line === "" ? { word } : { word, line });

/** A refusal in the reader's words: the way back in by the sentence it has today, the shell's as it said it. */
const refusalSaid = (refusal: GatedRefusal, t: Text): string =>
  refusal.word === "said" ? refusal.said : t(ACCOUNT_REFUSALS.security.sign_in.key);

/**
 * Settings › Security: whether unused recovery codes exist and whether an authenticator is set up, each with its
 * verb. Everything it says is a claim about what the account has enrolled, so while that is not read it draws
 * nothing, and over a read that failed it draws the reason and nothing below it. A set of codes just made is the
 * act's own answer and the only set that works, so it stands until Done, a failed read said beside it; a new
 * authenticator's key stands the same way, with its code and its Cancel. It holds no state and reaches nothing: it
 * draws its model, and its verbs are the model's.
 */
export function SecurityPane({ model, factor }: SecurityPaneProps) {
  const t = useText("security");
  const own = useText("accountSecurity");
  const { enrolled } = model;
  if (enrolled.at === "loading") return null;
  const fresh =
    model.codes.at === "shown" ? <FreshCodes codes={model.codes.codes} done={model.codesDone} /> : null;
  const key = model.authenticator.at === "key" ? <NewAuthenticator model={model} /> : null;
  // A verb parked behind the factor; over a failed read that is only ever the key's code.
  const asked = model.ask ? factor(model.ask) : null;
  if (enrolled.at === "failed") {
    return (
      <>
        {fresh}
        {key}
        <SettingsSheet wants={wants(own("notRead"), refusalSaid(enrolled.why, t))} />
        {asked}
      </>
    );
  }
  return (
    <>
      {fresh}
      {key}
      <Enrolment model={model} />
      <Dialog
        open={model.codes.at === "asked"}
        onClose={model.cancelNewCodes}
        title={t(enrolled.recoveryCodes ? "codesReplaceTitle" : "codesGenerate")}
        hot
        line={t(enrolled.recoveryCodes ? "codesReplaceLine" : "codesReplaceWarning")}
        confirm={{
          label: t("codesConfirm"),
          onPress: model.confirmNewCodes,
          disabled: model.working !== null,
        }}
        cancel={{ label: t("cancel") }}
      />
      {asked}
    </>
  );
}

/** Whether the last refusal is the code's, with the code's field still there to say it at. */
const saidAtTheCode = (model: SecurityModel): boolean =>
  model.problem !== null && model.problem.with === "activate" && model.authenticator.at === "key";

/** A line's verb: a short word under the full name it has today, or the word that says it is on its way. */
function Verb(p: {
  readonly name: string;
  readonly word: string;
  readonly working: boolean;
  readonly off: boolean;
  readonly press: () => void;
}) {
  const t = useText("security");
  return p.working ? (
    <Button kind="two" size="s" disabled>
      {t("working")}
    </Button>
  ) : (
    <Button kind="two" size="s" label={p.name} disabled={p.off} onPress={p.press}>
      {p.word}
    </Button>
  );
}

/** The two facts, each with its verb, and what the last verb left to say. One verb at a time: the others are off. */
function Enrolment({ model }: { readonly model: SecurityModel }) {
  const t = useText("security");
  const own = useText("accountSecurity");
  const steps = useText("devices");
  const { enrolled, working, problem, nothingRan } = model;
  if (enrolled.at !== "read") return null;
  const nothingRanSaid = steps("stepUpCancelledNothingRan");
  // A code the server would not take is said at its field, while that field stands.
  const here = problem !== null && !saidAtTheCode(model) ? problem : null;
  const sheetWants = here
    ? wants(own("notDone"), refusalSaid(here.why, t))
    : nothingRan
      ? wants(own("cancelled"), nothingRanSaid)
      : undefined;
  const off = working !== null;
  return (
    <SettingsSheet wants={sheetWants}>
      {here && nothingRan ? <SettingNote>{nothingRanSaid}</SettingNote> : null}
      <SettingLine
        label={t("codesTitle")}
        value={own(enrolled.recoveryCodes ? "codesUnused" : "codesNoneUnused")}
        narrow="detail"
      >
        {model.codes.at === "shown" ? null : (
          <Verb
            name={t(enrolled.recoveryCodes ? "codesReplace" : "codesGenerate")}
            word={own(enrolled.recoveryCodes ? "replace" : "generate")}
            working={working === "newCodes"}
            off={off}
            press={model.askNewCodes}
          />
        )}
      </SettingLine>
      {enrolled.recoveryCodes ? null : <SettingNote warn>{t("codesNone")}</SettingNote>}
      <SettingLine
        label={t("totpTitle")}
        value={own(enrolled.authenticator ? "on" : "notSetUp")}
        narrow="detail"
      >
        {model.authenticator.at === "key" ? null : (
          <>
            <Verb
              name={t(enrolled.authenticator ? "totpReplace" : "totpAdd")}
              word={own(enrolled.authenticator ? "replace" : "setUp")}
              working={working === "startAuthenticator"}
              off={off}
              press={model.startAuthenticator}
            />
            {/* Offered only while another factor would survive it. */}
            {enrolled.authenticator && enrolled.passkey ? (
              <Verb
                name={t("totpRemove")}
                word={own("remove")}
                working={working === "removeAuthenticator"}
                off={off}
                press={model.removeAuthenticator}
              />
            ) : null}
          </>
        )}
      </SettingLine>
    </SettingsSheet>
  );
}

/** The new set, shown once: each code a line of its own to copy from, and Done, which drops them. */
function FreshCodes({ codes, done }: { readonly codes: readonly string[]; readonly done: () => void }) {
  const t = useText("security");
  return (
    <SettingsSheet title={t("codesTitle")} sign="key" aside={t("shownOnce")} hot>
      {codes.map((code) => (
        <SettingNote key={code}>{code}</SettingNote>
      ))}
      <CopySecret value={codes.join("\n")} />
      <Button kind="ink" size="s" onPress={done}>
        {t("codesDone")}
      </Button>
    </SettingsSheet>
  );
}

/** A new authenticator: its key to type into the app, the app's six digits, and the verb that turns it on. */
function NewAuthenticator({ model }: { readonly model: SecurityModel }) {
  const t = useText("security");
  const own = useText("accountSecurity");
  if (model.authenticator.at !== "key") return null;
  const { key, code } = model.authenticator;
  const activating = model.working === "activate";
  const refused = model.problem !== null && saidAtTheCode(model) ? refusalSaid(model.problem.why, t) : null;
  return (
    <SettingsSheet title={t("totpTitle")} sign="shield">
      <SettingLine label={own("byHandLabel")} value={key} narrow="detail">
        <CopySecret value={key} />
      </SettingLine>
      <Field
        label={t("totpSixDigits")}
        placeholder="000000"
        value={code}
        onChange={model.typeCode}
        inputMode="numeric"
        autoComplete="one-time-code"
        refusal={refused === null ? undefined : refused === "" ? own("notDone") : refused}
      />
      <Button
        kind="ink"
        size="s"
        disabled={model.working !== null || code.trim() === ""}
        onPress={model.activate}
      >
        {activating ? t("working") : t("totpActivate")}
      </Button>
      {/* Off while a verb is on its way or its factor is asked: a later factor never turns on a key that was cancelled. */}
      <Button
        kind="quiet"
        size="s"
        disabled={model.working !== null || model.ask !== null}
        onPress={model.cancelAuthenticator}
      >
        {t("cancel")}
      </Button>
    </SettingsSheet>
  );
}

function CopySecret({ value }: { readonly value: string }) {
  const own = useText("accountSecurity");
  const [result, setResult] = useState<"copied" | "copyFailed">();
  return (
    <>
      <Button
        kind="two"
        size="s"
        onPress={async (event) => {
          const win = event.currentTarget.ownerDocument.defaultView;
          const copied = win ? await browserClipboard(win)(value) : false;
          setResult(copied ? "copied" : "copyFailed");
        }}
      >
        {own("copy")}
      </Button>
      <span role="status">{result ? own(result) : null}</span>
    </>
  );
}
