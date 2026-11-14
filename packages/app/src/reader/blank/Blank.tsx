/** Nothing open: the column says what the list above it holds, or its own word where no list stands. */
import { BlankColumn } from "@ohmail/ui/mail";
import { blankOf } from "@ohmail/app-logic/reader";
import { useListBlank } from "@ohmail/app-logic/reading";
import { useText } from "../../text/index.js";

export function Blank() {
  const t = useText("reader");
  const blank = blankOf(useListBlank(), t("blank.none"));
  if (blank === null) return null;
  return <BlankColumn hot={blank.hot}>{blank.label}</BlankColumn>;
}
