import type { EngineMessage } from "@ohmail/wire";
import {
  consentPartition,
  inverseMutations,
  pressForecast,
  senderKey,
  type OhmailEngine,
} from "@ohmail/client-engine";
import { shellConsentOptions, type FirstImports, type ShellConsentFacts } from "./consent-options.js";
import type { ToastFn } from "./report.js";
import {
  dispatchScreeningChange,
  isOwnSubject,
  movesAtLanding,
  planScreeningChange,
  ruleMatchOf,
  screeningPath,
  screeningToast,
  senderScreening,
  type ScreeningDest,
  type ScreeningScope,
} from "./sender-screening.js";
import { browserOffline, queuedWaitOf } from "./queued-sentence.js";
import type { ShellDispatch } from "./shell-dispatch.js";
import type { Translator } from "../text/translator.js";

interface ContactRead {
  engine: OhmailEngine;
  press: ShellDispatch;
  seedId: string;
  address: string;
  ownAddresses: readonly string[];
  consent: ShellConsentFacts | null;
  firstImports?: FirstImports;
  demo: boolean;
}

function readContact(input: ContactRead) {
  const { engine, press, seedId, address, ownAddresses, consent, firstImports, demo } = input;
  const reader = engine.verbRead();
  const seed = reader.get<EngineMessage>("message", seedId);
  if (!seed) return null;
  const key = senderKey(address);
  const onSender = senderKey(seed.from.address) === key;
  if (!onSender && ![...seed.to, ...seed.cc].some((person) => senderKey(person.address) === key)) return null;
  if (isOwnSubject(reader, seedId, onSender ? undefined : address, ownAddresses)) return null;
  const now = new Date();
  const options =
    consent && !demo ? shellConsentOptions(consent, now, ownAddresses, firstImports) : { now, ownAddresses };
  const places = consent && !demo ? consentPartition(reader, options).placeOf : undefined;
  const rules = press.routing.planOver.current?.(reader);
  const sender = senderScreening(reader, seedId, address, places, rules);
  return sender ? { reader, sender, options, rules, now, onSender } : null;
}

export function contactScreening(input: ContactRead) {
  return readContact(input)?.sender ?? null;
}

/** A destination press in the contact card, over the same planner and Undo window as the room's routing verbs. */
export function screenContact(
  input: ContactRead & {
    dest: ScreeningDest;
    scope: ScreeningScope;
    makeRule: boolean;
    applyRetro: boolean;
    name: string;
    place: string;
    t: Translator;
    toast: ToastFn;
  },
): void {
  const { engine, press, seedId, dest, scope, makeRule, applyRetro, name, place, t, toast } = input;
  const read = readContact(input);
  if (!read) return;
  const { reader, sender, options, rules, now, onSender } = read;
  const plan = planScreeningChange(sender, dest, scope, makeRule, applyRetro);
  const decide = plan.mutations.find((mutation) => mutation.kind === "screener_decide");
  const forecast = pressForecast({
    reader,
    options,
    rules,
    now,
    scope,
    subject: sender.scopes[scope].messages,
    match: ruleMatchOf(sender, scope),
    wanted: plan.wanted,
    makeRule,
    applyRetro,
    decide,
    seedId: onSender ? seedId : undefined,
  });
  const moves = movesAtLanding(plan, forecast);
  const note = { sender: name, place, count: plan.moved + moves.length };
  const send = (mutation: Parameters<OhmailEngine["mutate"]>[0]) =>
    press.fileAndRefresh(engine.mutate(mutation));
  if (screeningPath(sender, scope, makeRule) !== "window" || plan.ruleMutations.length === 0 || input.demo) {
    if (!decide && plan.ruleMutations.length === 0 && moves.length === 0 && !plan.rule) {
      toast(t("screening.toastAlready", note));
      return;
    }
    void dispatchScreeningChange(plan, moves, send, moves.length, decide !== undefined).then((key) => {
      if (key) toast(t(`screening.${key}`, note));
    });
    return;
  }

  const inverses = moves.flatMap((move) => inverseMutations(reader, move));
  const opened = press.routing.holdScreen({
    id: crypto.randomUUID(),
    seedId,
    address: sender.address,
    dest,
    note,
    messageIds: moves.map((move) => move.messageId),
    makeRule,
    applyRetro,
    resolution: "keep",
    shown: [],
    moves: moves.map(send),
    after: ({ worst, results }) => {
      if (worst === null || worst === "confirmed" || worst === "superseded") return;
      const key = screeningToast(plan, worst, moves.length, queuedWaitOf(results, browserOffline()));
      toast(t(`screening.${key}`, note));
    },
  });
  const sentence = t(`screening.${screeningToast(plan, null, moves.length)}`, note);
  if (opened.held) {
    press.toastWithUndo(sentence, inverses, {
      cancel: () => press.routing.undo(press.routing.subjectOf(sender.address)),
      undone: t("screening.toastRoutingUndone"),
    });
  } else {
    toast(`${sentence} ${t("session.noUndoHere")}`);
  }
}
