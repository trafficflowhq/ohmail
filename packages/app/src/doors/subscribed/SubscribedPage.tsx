/**
 * AFTER PAYING. The page the payment page sends a person back to: it goes on to the app by itself where a session
 * stands, and otherwise says the one true sentence and offers the way to the app. It claims nothing about the payment.
 * Its words are outside the document's first cut, so until they have arrived it waits without a word.
 */
import type { ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { NONE, type None } from "../../host/contract.js";
import { useText } from "../../text/index.js";
import { Said } from "../stage/Said.js";
import type { SubscribedDoor } from "./door.js";

export function SubscribedPage({ door }: { door: SubscribedDoor | None }): ReactNode {
  const subscribed = useText("subscribed");
  const gate = useText("gate");
  if (door === NONE)
    return (
      <Page acts={null}>
        <Said text={gate("lede")} />
      </Page>
    );
  /* A sentence missing from the document is drawn as nothing: the page waits, wordless, until the catalogue lands. */
  if (door.state.at === "continuing" || !subscribed.has("title"))
    return (
      <div className="way-live" aria-busy="true" aria-live="polite">
        <Page acts={null}>
          {subscribed.has("continuing") ? <Said text={subscribed("continuing")} /> : null}
        </Page>
      </div>
    );
  return (
    <Page
      line={subscribed("body")}
      note={subscribed("note")}
      acts={
        <Button size="l" onPress={door.open}>
          {subscribed("open")}
        </Button>
      }
    >
      <Said text={subscribed("title")} dot="ink" />
    </Page>
  );
}
