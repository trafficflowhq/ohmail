/**
 * THE SECOND FACTOR, ASKED AGAIN: one dialog, the same in every place that parks a verb behind it. It asks for a factor
 * the account has (a passkey where this browser can run the ceremony, the one-time code otherwise, a recovery code
 * "instead"), says the place's own line about what happens the moment it verifies, and hands the place one answer:
 * verified, cancelled, discarded (a factor that landed after Cancel), or the window's account gone from this browser.
 * Mounted means open. Its words are outside the document's first cut, so until they have arrived it waits wordless.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button, Dialog, Field, RefusalLine } from "@ohmail/ui/base";
import { useText, type Text } from "../../text/index.js";
import { useCeremonyGeneration } from "./ceremony-generation.js";
import type { StepUpDoor, StepUpFactor, StepUpFactors, StepUpProps, StepUpRefusal } from "./door.js";
import "./placement.css";

const TITLE: Readonly<Record<StepUpFactor, string>> = {
  passkey: "titlePasskey",
  code: "titleCode",
  recovery: "titleRecovery",
};
const INSTEAD: Readonly<Record<StepUpFactor, string>> = {
  passkey: "usePasskey",
  code: "useCode",
  recovery: "useRecovery",
};
const SAID: Readonly<Record<"slowed" | "bad_code" | "bad_passkey" | "bad_recovery" | "refused", string>> = {
  slowed: "slowed",
  bad_code: "badCode",
  bad_passkey: "badPasskey",
  bad_recovery: "badRecovery",
  refused: "refused",
};
const WAYS: readonly StepUpFactor[] = ["passkey", "code", "recovery"];

/** A refusal in the reader's words: the lock with its minutes, each other word its own sentence, the shell's as said. */
function sentenceOf(refusal: StepUpRefusal, t: Text): string {
  if (refusal.word === "said" || refusal.word === "owner_absent") return refusal.said;
  if (refusal.word === "locked") return t("locked", { minutes: refusal.minutes });
  return t(SAID[refusal.word]);
}

/** The kit's dialog draws the closing dot itself: the catalogue's sentence is handed in without its full stop. */
const withoutStop = (sentence: string): string => (sentence.endsWith(".") ? sentence.slice(0, -1) : sentence);

/** Where the read's answer goes: the factors and the way to start with, or the refusal said. */
interface FactorsHeard {
  factors(factors: StepUpFactors): void;
  factor(factor: StepUpFactor): void;
  refusal(refusal: StepUpRefusal): void;
}

/**
 * One read of the factors, as the dialog opens: the door a place hands, and where its answer goes, are the ones of
 * the dialog's first draw, for the dialog's life. An absent owner ends the ceremony first, so a factor already on its
 * way runs nothing the place parked, and the place is handed back.
 */
function useFactorsOnOpen(
  door: StepUpDoor,
  hands: { readonly current: StepUpProps },
  end: () => void,
  heard: FactorsHeard,
): void {
  const opened = useRef({ door, heard });
  useEffect(() => {
    let live = true;
    const { door: first, heard: to } = opened.current;
    void first.factors().then((read) => {
      if (!live) return;
      if (read.ok) {
        to.factors(read.factors);
        to.factor(read.factors.passkey ? "passkey" : "code");
        return;
      }
      if (read.refusal.word === "owner_absent" && hands.current.onOwnerAbsent) {
        end();
        hands.current.onOwnerAbsent();
        return;
      }
      to.refusal(read.refusal);
    });
    return () => {
      live = false;
    };
  }, [end, hands]);
}

/** What the dialog asks under its title: the factor's own field, or the passkey's refusal. */
function Asked(p: {
  t: Text;
  factor: StepUpFactor;
  said: string | null;
  typed: string;
  type: (typed: string) => void;
  field: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  submit: (e: FormEvent) => void;
}): ReactNode {
  const { t, factor, said } = p;
  if (factor === "passkey") return said === null ? null : <RefusalLine>{said}</RefusalLine>;
  return (
    <form className="way-step-up-form" onSubmit={p.submit}>
      <Field
        ref={p.field}
        label={t(factor === "code" ? "codeLabel" : "recoveryLabel")}
        value={p.typed}
        onChange={p.type}
        autoComplete={factor === "code" ? "one-time-code" : "off"}
        /* As the prompt it replaced: an authenticator's code opens the number pad, and each code has its length. */
        inputMode={factor === "code" ? "numeric" : undefined}
        maxLength={factor === "code" ? 10 : 64}
        hint={factor === "code" ? t("codeHint") : undefined}
        refusal={said ?? undefined}
      />
    </form>
  );
}

/** The other ways to the same answer, under the answers: one quiet button each, for a factor the account has. */
function waysOf(t: Text, instead: readonly StepUpFactor[], use: (way: StepUpFactor) => void): ReactNode {
  return instead.length === 0
    ? undefined
    : instead.map((way) => (
        <Button key={way} kind="quiet" size="s" onPress={() => use(way)}>
          {t(INSTEAD[way])}
        </Button>
      ));
}

export function StepUpDialog(props: StepUpProps & { door: StepUpDoor; line?: string }): ReactNode {
  const { door, line } = props;
  const t = useText("stepUp");
  /**
   * THE CEREMONY'S GENERATION: Cancel, Esc, the scrim and leaving end it before the place hears anything, so a factor
   * already in flight acts on nothing; each press captures it before its first wait and is let through at one door.
   */
  const ceremony = useCeremonyGeneration();
  /* The place's latest answers: a factor that lands late calls what the place hands now, never a stale closure. */
  const hands = useRef<StepUpProps>(props);
  useLayoutEffect(() => {
    hands.current = props;
  });
  /* Leaving ends it as Cancel does: a factor landing after that runs nothing the place parked. */
  const { end } = ceremony;
  useLayoutEffect(() => () => end(), [end]);

  const [factors, setFactors] = useState<StepUpFactors | null>(null);
  /* While the factors are unknown the code field stands, never the passkey button. */
  const [factor, setFactor] = useState<StepUpFactor>("code");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<StepUpRefusal | null>(null);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useFactorsOnOpen(door, hands, end, { factors: setFactors, factor: setFactor, refusal: setRefusal });

  /* A code's field takes the keys as its way appears; the kit's dialog has put them on its first button by then. */
  useEffect(() => {
    if (factor !== "passkey") field.current?.focus();
  }, [factor]);

  /** The one way out: the ceremony ends first, and only then does the place get its page back. */
  const leave = useCallback((): void => {
    end();
    hands.current.onCancel();
  }, [end]);

  const ready = factor === "passkey" || typed.trim().length > 0;
  /* One check at a time, whatever the draw has caught up with: a second press while one is on its way sends nothing. */
  const checking = useRef(false);
  const press = (): void => {
    if (checking.current || !ready) return;
    checking.current = true;
    setBusy(true);
    setRefusal(null);
    // BEFORE the first wait: this press belongs to the ceremony it started in.
    const gen = ceremony.begin();
    void door.verify(factor, factor === "passkey" ? "" : typed).then((out) => {
      checking.current = false;
      if (out.ok) {
        setTyped("");
        // THE ONE DOOR. A factor that lands after Cancel runs no parked verb, and the place says so.
        if (!ceremony.claim(gen)) {
          setBusy(false);
          hands.current.onDiscarded();
          return;
        }
        hands.current.onVerified();
        return;
      }
      // A refused factor ends the ceremony: a second answer cannot act either.
      end();
      setBusy(false);
      if (out.refusal.word === "owner_absent" && hands.current.onOwnerAbsent) {
        hands.current.onOwnerAbsent();
        return;
      }
      setRefusal(out.refusal);
    });
  };
  const use = (way: StepUpFactor): void => {
    setFactor(way);
    setTyped("");
    setRefusal(null);
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    press();
  };

  /* Its sentences are not in the first cut: wordless until they have arrived; the factors are read meanwhile. */
  if (!t.has(TITLE.code)) return <div className="way-live" aria-busy="true" />;

  const said = refusal === null ? null : sentenceOf(refusal, t);
  const instead = factors === null ? [] : WAYS.filter((way) => way !== factor && factors[way]);
  return (
    <Dialog
      key={factor}
      open
      onClose={leave}
      title={withoutStop(t(TITLE[factor]))}
      hot
      line={line ?? t("door")}
      confirm={{
        label: busy ? t("working") : factor === "passkey" ? t("passkey") : t("verify"),
        onPress: press,
        /* Never off while it works: a button that turns off drops the keys out of the dialog, and Esc would then cancel
           nothing while the factor is on its way. It says it is working and takes no second press instead. */
        disabled: !ready,
        keyHint: "↵",
      }}
      cancel={{ label: t("cancel"), keyHint: "Esc" }}
      under={waysOf(t, instead, use)}
    >
      {factor === "passkey" && said === null ? undefined : (
        <Asked
          t={t}
          factor={factor}
          said={said}
          typed={typed}
          type={setTyped}
          field={field}
          submit={submit}
        />
      )}
    </Dialog>
  );
}
