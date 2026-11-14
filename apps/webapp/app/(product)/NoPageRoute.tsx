"use client";

/**
 * The no-page as the web serves it: at an address nothing claims (`not-found.tsx`), and at `/` in a build with no
 * server behind it (`mailbox/page.tsx`). The server file reads the words and hands them in; each way on leaves as a
 * document: `/` decides again for the visitor on every deployment.
 */
import { NoPagePage, type NoPageDoor } from "@ohmail/app/doors/no-page";
import { WebDoor } from "./door-device";

type Words<S extends NoPageDoor["at"]> = Extract<NoPageDoor, { at: S }>["words"];

export function NoPageRoute(
  props: { at: "missing"; words: Words<"missing"> } | { at: "noserver"; words: Words<"noserver"> },
) {
  const door: NoPageDoor = props.at === "missing"
    ? { at: "missing", words: props.words, home: () => { window.location.assign("/"); } }
    : {
      at: "noserver",
      words: props.words,
      demo: () => { window.location.assign("/?demo=1"); },
      signIn: () => { window.location.assign("/login"); },
    };
  return (
    <WebDoor>
      <NoPagePage door={door} />
    </WebDoor>
  );
}
