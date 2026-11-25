import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ClassifierPort } from "../packages/core/src/classifier-port.js";
import {
  askScreeningQuestion, boundedScreenerInputSize, screenerInputSize, type ScreeningAsk,
} from "../packages/core/src/classify-prompt.js";
import { askScreenerRewrite, type ScreenerRewriteReference } from "../packages/core/src/screener-learning-rewrite.js";
import { isScreenerTopic, screenerLessonKind, screenerTopic } from "../packages/db/src/screener-topics.js";
import { isDecidedDestination, type Destination } from "../packages/core/src/types.js";
import { screenerLearningContext, type ScreenerLearningState, type ScreenerLesson } from "../packages/db/src/screener-learning.js";

export interface ReplayChoice {
  mailbox: string;
  at: string;
  language: "en" | "de";
  ask: Pick<ScreeningAsk, "fromAddress" | "subject" | "snippet" | "ohboxBar" | "senderFacts">;
  senderName?: string;
  suggested: string | null;
  previous: string | null;
  chosen: string;
}

const DAYS_30_MS = 30 * 86_400_000;
const DENY = new Set(["ohmail/Screened", "ohmail/Quarantine"]);
const allowedPlace = (value: unknown) => value === null || (typeof value === "string" && isDecidedDestination(value as Destination));
const noop = async () => {};

function isReplayChoice(raw: unknown): raw is ReplayChoice {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as Partial<ReplayChoice>;
  const ask = row.ask;
  return (row.senderName === undefined || typeof row.senderName === "string")
    && typeof row.mailbox === "string" && row.mailbox.length > 0 && typeof row.at === "string"
    && Number.isFinite(Date.parse(row.at)) && (row.language === "en" || row.language === "de")
    && !!ask && typeof ask.fromAddress === "string" && typeof ask.subject === "string" && typeof ask.snippet === "string"
    && (ask.ohboxBar === undefined || typeof ask.ohboxBar === "string")
    && (ask.senderFacts === undefined || typeof ask.senderFacts === "string")
    && allowedPlace(row.suggested) && allowedPlace(row.previous)
    && typeof row.chosen === "string" && allowedPlace(row.chosen);
}

function emptyScore() {
  return { matches: 0, unavailable: 0, wrongDenies: 0, wrongAdmissions: 0 };
}
function score(stats: ReturnType<typeof emptyScore>, actual: string, answer: string | null) {
  if (answer === null || answer === "ohmail/Screener") stats.unavailable++;
  if (answer === actual) stats.matches++;
  if (answer !== null && DENY.has(answer) && !DENY.has(actual)) stats.wrongDenies++;
  if (answer === "INBOX" && actual !== "INBOX") stats.wrongAdmissions++;
}

function tally() { return { eligible: 0, withoutNote: emptyScore(), withNote: emptyScore() }; }

function report(stats: ReturnType<typeof tally>) {
  const { eligible } = stats;
  return {
    eligible,
    withoutNote: { ...stats.withoutNote, agreement: eligible ? stats.withoutNote.matches / eligible : null },
    withNote: { ...stats.withNote, agreement: eligible ? stats.withNote.matches / eligible : null },
  };
}

export async function replayScreenerLearning(rows: readonly unknown[], model: ClassifierPort) {
  const rewrite = model.rewriteScreener?.bind(model);
  if (!rewrite) throw new Error("Missing replay rewrite model");
  const valid = rows.filter(isReplayChoice);
  const boxes = new Map<string, ScreenerLearningState>();
  const references = new Map<string, ScreenerRewriteReference>();
  const all = tally();
  const groups = new Map<string, ReturnType<typeof tally>>();
  const inputSizes = { suggestion: 0, rewrite: 0 };
  let rewritesFailed = 0;
  const meteredClassify: ClassifierPort["classify"] = async (input, call) => {
    inputSizes.suggestion = Math.max(inputSizes.suggestion, screenerInputSize(input));
    return (model.screen ?? model.classify).call(model, input, call);
  };
  const instrumented = { classify: meteredClassify, screen: meteredClassify };
  const predict = async (ask: ScreeningAsk) => {
    try { return await askScreeningQuestion(instrumented, ask, { beforeDispatch: noop }); }
    catch { return null; }
  };
  const byTime = valid.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const [index, row] of byTime.entries()) {
    const at = Date.parse(row.at);
    const old = boxes.get(row.mailbox);
    const state: ScreenerLearningState = old ?? {
      enabled: true, notice: false, text: "", lessons: [], revision: 0, rewrittenRevision: 0, updatedAt: null,
    };
    state.lessons = state.lessons.filter(lesson => {
      if (lesson.at > at - DAYS_30_MS) return true;
      references.delete(lesson.id);
      return false;
    });
    const { fromAddress, subject, snippet, ohboxBar, senderFacts } = row.ask;
    const ask = {
      fromAddress, subject, snippet, ...(ohboxBar ? { ohboxBar } : {}), ...(senderFacts ? { senderFacts } : {}),
    };
    const without = await predict(ask);
    const withNote = await predict({ ...ask, ...screenerLearningContext(state) });
    const grade = (group: ReturnType<typeof tally>) => {
      group.eligible++;
      score(group.withoutNote, row.chosen, without?.destination ?? null);
      score(group.withNote, row.chosen, withNote?.destination ?? null);
    };
    const { suggested, previous, chosen } = row;
    const kind = screenerLessonKind(chosen, suggested, previous);
    grade(all);
    for (const key of [kind, row.language, state.text ? "established" : "cold"]) {
      const group = groups.get(key) ?? tally();
      grade(group);
      groups.set(key, group);
    }

    // Score before revealing the choice. Rebuild the note only for this mailbox.
    const topic = isScreenerTopic(without?.topic) ? without.topic : screenerTopic(subject);
    const decisionId = String(index);
    const lesson: ScreenerLesson = { id: decisionId, decisionId, messageRef: decisionId, at, kind, topic, suggested, previous, chosen };
    references.set(decisionId, { senderName: row.senderName ?? null, subject });
    state.lessons.push(lesson);
    if (state.lessons.length > 32) references.delete(state.lessons.shift()!.id);
    const choices = state.lessons.slice(-9).map((item, i, same) => ({
      kind: item.kind, topic: item.topic, suggested: item.suggested, previous: item.previous, chosen: item.chosen,
      ...(i < same.length - 1 ? { earlier: true as const } : {}),
    }));
    try {
      state.text = await askScreenerRewrite(async (request, call) => {
        inputSizes.rewrite = Math.max(inputSizes.rewrite, boundedScreenerInputSize(request.system, request.input, request.schema));
        return rewrite(request, call);
      }, { language: row.language, previous: state.text, choices }, noop, undefined,
      state.lessons.map(item => references.get(item.id)!));
    } catch {
      rewritesFailed++;
    }
    boxes.set(row.mailbox, state);
  }
  return {
    rows: rows.length, invalid: rows.length - valid.length,
    ...report(all), groups: Object.fromEntries([...groups].map(([key, value]) => [key, report(value)])),
    inputSizes, rewritesFailed,
  };
}

async function main(args: string[]) {
  const [inputPath, adapterPath] = args;
  if (!inputPath || !adapterPath || args.length !== 2) throw new Error("Supply a replay export and an adapter");
  const input = JSON.parse(await readFile(inputPath, "utf8")) as { version?: unknown; choices?: unknown };
  if (input.version !== 1 || !Array.isArray(input.choices)) throw new Error("Invalid replay export");
  const { model } = await import(pathToFileURL(resolve(adapterPath)).href) as { model: ClassifierPort };
  const result = await replayScreenerLearning(input.choices, model);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main(process.argv.slice(2)).catch(() => {
    process.stderr.write("Screener replay could not run. Check the export and the model adapter.\n");
    process.exitCode = 1;
  });
}
