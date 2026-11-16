"use client";

import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import {
  createTranslator,
  IntlErrorCode,
  type IntlError,
  type RichTranslationValues,
  type TranslationValues,
} from "use-intl/core";
import type { Messages } from "./fill.js";

export type Locale = "en" | "de";
export type TranslationValue = TranslationValues[string];

/** One namespace's sentences. A key it cannot render is drawn as nothing and reported, never shown. */
export interface Text {
  (key: string, values?: Record<string, TranslationValue>): string;
  rich(key: string, values?: Record<string, unknown>): ReactNode;
  has(key: string): boolean;
}

interface Shelf {
  readonly locale: Locale;
  readonly timeZone: string;
  textOf(namespace: string): Text;
  readonly pending: boolean;
}

/*
 * The reader's own context, not the web framework's: the desktop aliases that package to its own copy, and two copies
 * of a package are two contexts. Nothing here reads either.
 */
const TextContext = createContext<Shelf | null>(null);

/** The catalogue is filled over English already (`fillOver`), so a key it lacks is missing in English too. */
function report(error: IntlError): void {
  console.error(`text: ${error.code}: ${error.originalMessage ?? error.message}`);
}

/** While the catalogue is on its way, a namespace the document did not carry is missing by design: it is not reported. */
function reportUnlessPending(error: IntlError): void {
  if (error.code === IntlErrorCode.MISSING_MESSAGE) return;
  report(error);
}

type Raw = {
  (key: string, values?: TranslationValues): string;
  rich(key: string, values?: RichTranslationValues): ReactNode;
  has(key: string): boolean;
};

function shelfOf(
  locale: Locale,
  messages: Messages,
  timeZone: string,
  now: Date | undefined,
  pending: boolean,
): Shelf {
  const made = new Map<string, Text>();
  const textOf = (namespace: string): Text => {
    const known = made.get(namespace);
    if (known) return known;
    const held = typeof messages[namespace] === "object";
    // Made at the first sentence asked: a namespace a caller holds but never reads (a place's rail words where a
    // model is fed) reports nothing.
    let made1: Raw | null = null;
    const raw = (): Raw =>
      (made1 ??= createTranslator({
        locale,
        messages: messages as Parameters<typeof createTranslator>[0]["messages"],
        namespace: namespace as never,
        timeZone,
        now,
        onError: pending ? reportUnlessPending : report,
        getMessageFallback: () => "",
      }) as unknown as Raw);
    const text = ((key, values) => raw()(key, values as TranslationValues)) as Text;
    text.rich = (key, values) => raw().rich(key, values as RichTranslationValues);
    text.has = (key) => held && typeof readPath(messages[namespace] as Messages, key) === "string";
    made.set(namespace, text);
    return text;
  };
  return { locale, timeZone, textOf, pending };
}

function readPath(tree: Messages, key: string): unknown {
  let at: unknown = tree;
  for (const part of key.split(".")) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Messages)[part];
  }
  return at;
}

export function TextProvider(props: {
  locale: Locale;
  messages: Messages;
  timeZone: string;
  now?: Date;
  /** The catalogue is the first screen's cut and the rest is on its way, as the intl provider beside it is told. */
  pending?: boolean;
  children: ReactNode;
}): ReactNode {
  const { locale, messages, timeZone, now } = props;
  const pending = props.pending === true;
  const shelf = useMemo(
    () => shelfOf(locale, messages, timeZone, now, pending),
    [locale, messages, timeZone, now, pending],
  );
  return createElement(TextContext.Provider, { value: shelf }, props.children);
}

function useShelf(asked: string): Shelf {
  const shelf = useContext(TextContext);
  if (shelf === null) throw new Error(`${asked} was called with no TextProvider above it`);
  return shelf;
}

/** The sentences of one namespace: a feature reads its own place's and `shared`, nothing else. */
export function useText(namespace: string): Text {
  return useShelf(`useText("${namespace}")`).textOf(namespace);
}

/** Any namespace's sentences by name, from one read of the reader: for a list of namespaces read in a loop. */
export function useTextLookup(): (namespace: string) => Text {
  return useShelf("useTextLookup()").textOf;
}

/** Whether a `TextProvider` stands above: a shell that brings its own leaves an outer one in charge. */
export function useTextProvided(): boolean {
  return useContext(TextContext) !== null;
}

/** Whether the catalogue is still on its way: a sentence it lacks now may be drawn when it lands. */
export function useTextPending(): boolean {
  return useContext(TextContext)?.pending === true;
}

export function useLocale(): Locale {
  return useShelf("useLocale()").locale;
}

/** The zone the reader's times are said in: what is "today" is asked there. */
export function useTimeZone(): string {
  return useShelf("useTimeZone()").timeZone;
}
