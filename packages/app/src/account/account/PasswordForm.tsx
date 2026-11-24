import { useState, type FormEvent } from "react";
import { Button, Field, RefusalLine } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import { ACCOUNT_REFUSALS, type FactorSlot } from "../contract.js";
import type { PasswordModel } from "./password.js";
import "./placement.css";

export interface PasswordFormProps {
  readonly model: PasswordModel;
  /** The factor's dialog, filled by the shell: drawn while the change is parked behind it. */
  readonly factor: FactorSlot;
  /**
   * A way out of the form without a change, where the place that draws it has one. It is off while a change is owed:
   * on its way, or its factor asked (the dialog's own Cancel drops it then).
   */
  readonly onCancel?: () => void;
}

type Refusal = NonNullable<PasswordModel["refusal"]>;
/** Which blank a refusal is about: it is said there. The others are said over the form's answer. */
const BLANK: Readonly<Partial<Record<Refusal["word"], "current" | "next" | "again">>> = {
  needCurrent: "current",
  wrong_current: "current",
  tooShort: "next",
  tooLong: "next",
  same: "next",
  mismatch: "again",
};
/** A refusal in the reader's words: each by the sentence it has today. A typed check's word is its key. */
function refusalSaid(refusal: Refusal, t: Text, steps: Text): string {
  switch (refusal.word) {
    case "said":
      return refusal.said;
    case "sign_in":
      return steps(ACCOUNT_REFUSALS.password.sign_in.key);
    case "locked":
      // The lock's own length where a door named none.
      return t(ACCOUNT_REFUSALS.password.locked.key, { minutes: refusal.minutes ?? 15 });
    case "wrong_current":
    case "slowed":
    case "conflict":
    case "refused":
      return t(ACCOUNT_REFUSALS.password[refusal.word].key);
    default:
      return t(refusal.word);
  }
}

/**
 * The password change: the current one, the new one and the new one again, and Change. It is the one form of the
 * account's panes, so that Enter presses Change and a password manager finds the three blanks together. It has no
 * address and no method, its blanks carry no name, and its press never leaves by the browser's own submit: before
 * the page's script has taken it, a press sends nothing that was typed.
 *
 * Every attempt empties the three blanks, whatever comes of it. What was typed is handed to the model's one verb
 * and kept nowhere here.
 */
export function PasswordForm({ model, factor, onCancel }: PasswordFormProps) {
  const t = useText("passwordChange");
  const steps = useText("devices");
  const own = useText("accountOwn");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (model.sending || model.ask !== null) return;
    const typed = { current, next, again };
    // Nothing typed stays on the page behind an attempt.
    setCurrent("");
    setNext("");
    setAgain("");
    model.change(typed);
  };

  const { refusal } = model;
  const blank = refusal === null ? undefined : BLANK[refusal.word];
  const said = refusal === null ? null : refusalSaid(refusal, t, steps);
  const at = (which: "current" | "next" | "again"): string | undefined =>
    blank === which && said !== null ? said : undefined;
  // While the change is on its way the blanks are off. A password blank of the kit takes keys unless it is disabled.
  const off = model.sending;
  const over = blank === undefined && said !== null ? said : model.nothingChanged ? t("cancelled") : null;
  return (
    <>
      <form className="account-form" onSubmit={submit}>
        <div className="account-fields">
          <Field
            id="pwc-current"
            type="password"
            autoComplete="current-password"
            label={t("currentLabel")}
            value={current}
            onChange={setCurrent}
            disabled={off}
            refusal={at("current")}
          />
          <Field
            id="pwc-next"
            type="password"
            autoComplete="new-password"
            label={t("nextLabel")}
            value={next}
            onChange={setNext}
            disabled={off}
            hint={t("nextHint")}
            refusal={at("next")}
          />
          <Field
            id="pwc-repeat"
            type="password"
            autoComplete="new-password"
            label={t("repeatLabel")}
            value={again}
            onChange={setAgain}
            disabled={off}
            refusal={at("again")}
          />
        </div>
        {model.changed === null ? null : (
          <SettingNote>{t("done", { count: model.changed.ended })}</SettingNote>
        )}
        {over === null ? <SettingNote>{t("lead")}</SettingNote> : <RefusalLine start>{over}</RefusalLine>}
        <div className="account-acts">
          <Button type="submit" disabled={model.sending}>
            {model.sending ? t("working") : t("submit")}
          </Button>
          {onCancel ? (
            <Button kind="quiet" onPress={onCancel} disabled={model.sending || model.ask !== null}>
              {own("cancel")}
            </Button>
          ) : null}
        </div>
      </form>
      {/* Beside the form, never in it: the dialog has a form of its own, and Enter in it presses its own verb. */}
      {model.ask ? factor({ ...model.ask, line: t("factorBody") }) : null}
    </>
  );
}
