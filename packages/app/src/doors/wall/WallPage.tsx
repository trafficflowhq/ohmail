/**
 * THE WALL: what an account the service has refused sees in place of its mail. Its sentence says what happened and
 * when; its line that the mailbox is untouched (a page that only says "no" reads as data loss) and when what ohmail
 * keeps is erased. The way back is its ink button; the ways out stand beside it on a sheet, each with the line that
 * says what it does: the settings file, deleting now. While the service is asked again only Sign out stands. It draws
 * no mail and no list of it, and holds no address. The same page ends an account erased from another browser. Its
 * words are outside the document's first cut, so until they have arrived it waits wordless.
 */
import type { ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { useText, type Text } from "../../text/index.js";
import { Break, DoorLine, Fact, Heavy, Note, useLinePlace } from "../stage/DoorLine.js";
import { Way, Ways } from "../stage/DoorSheet.js";
import { Said } from "../../text/Said.js";
import type { WallDoor, WallHeadline, WallStanding, WallState } from "./door.js";
import "./placement.css";

type Refused = Extract<WallState, { at: "refused" }>;

/** One or two sentences under the page's sentence, as the kit's page takes them. */
const refusalOf = (said: (string | null)[]): readonly [string] | readonly [string, string] | undefined => {
  const [first, second] = said.filter((s): s is string => s !== null);
  if (first === undefined) return undefined;
  return second === undefined ? [first] : [first, second];
};

/** The headline, with its date where it carries one. */
const headlineOf = (headline: WallHeadline, t: Text): string =>
  "date" in headline ? t(headline.key, { date: headline.date }) : t(headline.key);

/** The line that matters and the note under it: what stands, and when what ohmail keeps is erased. */
function standingOf(standing: WallStanding, t: Text): { heavy: string; note?: string } {
  if (standing.kind === "fresh") return { heavy: t("neverLine"), note: t("neverNote") };
  if (standing.kind === "kept") return { heavy: t("keptLine"), note: t("keptNote") };
  const { erasure } = standing;
  const note =
    erasure.kind === "dated"
      ? t("erasure", { date: erasure.date })
      : erasure.kind === "held"
        ? t("erasureHeld")
        : erasure.kind === "unknown"
          ? t("erasureUnknown")
          : undefined;
  return { heavy: t("stoppedUntouched"), note };
}

/** What deleting now does, in the sentence that fits what the line said: with its date where it named one. */
function deleteHintOf(state: Refused, t: Text): string {
  const { standing } = state;
  if (state.deleteHint === "deleteHint" && standing.kind === "stopped" && standing.erasure.kind === "dated")
    return t("deleteHintOn", { date: standing.erasure.date });
  return t(state.deleteHint);
}

/** The ways out, on a sheet beside the sentence: the settings file where the server serves one, and deleting now. */
function WaysOut({ door, state, t }: { door: WallDoor; state: Refused; t: Text }): ReactNode {
  return (
    <>
      <Ways>
        {state.moveOut !== null ? (
          <Way
            icon="download"
            label={t("moveOut")}
            hint={t("moveOutLine")}
            onPress={door.moveOut}
            disabled={state.moveOut.exporting}
          />
        ) : null}
        <Way icon="trash" label={t("deleteNow")} hint={deleteHintOf(state, t)} onPress={door.deleteNow} />
      </Ways>
      {/* The self-host guide, for the file's way out: beside the page, never in place of it. */}
      {state.moveOut !== null ? (
        <p className="way-wall-guide">
          <Button kind="quiet" size="s" onPress={door.guide}>
            {t("moveOutGuide")}
          </Button>
        </p>
      ) : null}
    </>
  );
}

function RefusedPage({ door, state, t }: { door: WallDoor; state: Refused; t: Text }): ReactNode {
  const place = useLinePlace();
  const title = <Said text={headlineOf(state.headline, t)} />;
  const { heavy, note } = standingOf(state.standing, t);
  const signOut = (kind: "two" | "quiet") => (
    <Button kind={kind} size="l" onPress={door.signOut} disabled={state.signingOut}>
      {t("signOut")}
    </Button>
  );
  /* While the answer is in flight nothing else is true to offer; the way out stays. */
  if (state.check === "checking")
    return (
      <Page
        refusal={refusalOf([state.signOutSaid])}
        material={
          <DoorLine>
            <Heavy>{heavy}</Heavy>
            {note === undefined ? null : <Note>{note}</Note>}
            <Break />
            <Fact>{t("checkingTag")}</Fact>
          </DoorLine>
        }
        acts={
          <>
            {signOut("two")}
            {/* The wait is said as it is asked, as the shipped wall did; the tag shows it. */}
            <span className="way-unseen" role="status" aria-busy="true">
              {t("checkingTag")}
            </span>
          </>
        }
      >
        {title}
      </Page>
    );
  const { wayBack } = state;
  const pending = state.check === "pending";
  /* A payment not confirmed yet says so under the line: the page draws that line itself. */
  const line = pending ? (
    <DoorLine place={place}>
      <Heavy>{heavy}</Heavy>
      {note === undefined ? null : <Note>{note}</Note>}
      <Heavy>{t("pendingLine")}</Heavy>
      <Note>{t("pendingNote")}</Note>
    </DoorLine>
  ) : null;
  return (
    <Page
      columns={2}
      lineFirst
      refusal={refusalOf([
        wayBack?.refusal
          ? t(wayBack.refusal === "mintUnverified" ? "unverifiedEmail" : wayBack.refusal)
          : null,
        state.moveOut?.failed ? t("moveOutFailed") : null,
        state.signOutSaid,
      ])}
      material={
        <>
          {place === "after" ? line : null}
          <WaysOut door={door} state={state} t={t} />
        </>
      }
      line={pending ? undefined : heavy}
      note={pending ? undefined : note}
      acts={
        <>
          {place === "acts" ? line : null}
          {pending ? (
            <Button kind="two" size="l" onPress={door.checkAgain}>
              {t("checkAgain")}
            </Button>
          ) : null}
          {/* Only where the service runs an account page; the address itself is minted by the press. */}
          {wayBack !== null ? (
            <Button size="l" onPress={door.wayBack} disabled={wayBack.minting}>
              {t(wayBack.label)}
            </Button>
          ) : null}
          {signOut("quiet")}
          <Button kind="quiet" size="l" onPress={door.changePassword}>
            {t("changePassword")}
          </Button>
        </>
      }
    >
      {title}
    </Page>
  );
}

export function WallPage({ door }: { door: WallDoor }): ReactNode {
  const t = useText("accessLock");
  /* Its sentences are not in the first cut: wordless until they have arrived, and no press before them. */
  if (!t.has("title")) return <div className="way-live" aria-busy="true" />;
  const { state } = door;
  if (state.at === "erased")
    return (
      <Page
        refusal={state.blocked ? [t("erasedBlocked")] : undefined}
        line={t("erasedUntouched")}
        note={state.blocked ? undefined : t("erasedGone")}
        acts={
          <Button size="l" onPress={door.home}>
            {t("erasedHome")}
          </Button>
        }
      >
        <Said text={t("erasedTitle")} dot="ink" />
      </Page>
    );
  return <RefusedPage door={door} state={state} t={t} />;
}
