/**
 * The one text reader. A feature reads `useText("<its place>")` and `useText("shared")` under the `TextProvider` its
 * shell mounts; the shell hands the provider the catalogue it already gives its intl provider, German filled over
 * English with `fillOver`.
 */
export {
  TextProvider,
  useLocale,
  useText,
  useTextLookup,
  useTextPending,
  useTextProvided,
  useTimeZone,
  type Locale,
  type Text,
  type TranslationValue,
} from "./reader.js";
export { fillOver, type Messages } from "./fill.js";
