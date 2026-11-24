/**
 * NO PAGE, NO SERVER. What a build says at an address where nothing is, and where it has no server behind it. Its
 * words come in through its door; it reads no catalogue, so it says the same on the server and in the browser.
 */
import type { ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { Said } from "../../text/Said.js";
import type { NoPageDoor } from "./door.js";

/** A button says its words without the catalogue's closing full stop: on a capsule it is no sentence's end. */
const label = (words: string): string => (words.endsWith(".") ? words.slice(0, -1) : words);

export function NoPagePage({ door }: { door: NoPageDoor }): ReactNode {
  if (door.at === "missing") {
    const { words } = door;
    return (
      <Page
        line={words.note}
        acts={
          <Button size="l" onPress={door.home}>
            {label(words.home)}
          </Button>
        }
      >
        <Said text={words.title} />
      </Page>
    );
  }
  const { words } = door;
  return (
    <Page
      line={words.body}
      note={words.note}
      acts={
        <>
          <Button size="l" onPress={door.demo}>
            {label(words.demo)}
          </Button>
          <Button kind="two" size="l" onPress={door.signIn}>
            {label(words.signIn)}
          </Button>
        </>
      }
    >
      <Said text={words.title} />
    </Page>
  );
}
