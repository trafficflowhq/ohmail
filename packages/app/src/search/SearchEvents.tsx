import { ListLine } from "@ohmail/ui/mail";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import type { SearchBeside } from "./beside.js";

export function SearchEvents({ beside, text }: { beside: SearchBeside; text: string }) {
  const t = useText("search");
  const events = beside.events === NONE ? null : beside.events(text);
  if (events === null) return null;
  return (
    <ListLine
      act={{
        quiet: true,
        icon: "calendar",
        label: t("events", { count: events.count }),
        onPress: () => events.open(),
      }}
    />
  );
}
