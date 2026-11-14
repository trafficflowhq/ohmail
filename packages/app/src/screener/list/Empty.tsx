/**
 * A SECTION WITH NO ROWS says so once, and only what is so: nothing before the queue is read, why where the list is
 * withheld, and on Waiting the sentence that is true where nothing organizes the account's mail.
 */
import { sharedNotOrganizedWhy } from "@ohmail/app-logic/mail-state/mail-state";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { emptyOf, type ScreenerView } from "@ohmail/app-logic/screener";
import { Empty as KitEmpty, WaitRow } from "@ohmail/ui/base";
import { ListLine } from "@ohmail/ui/mail";
import { useFrame } from "../../frame/commands.js";
import { NONE } from "../../host/index.js";
import { useText } from "../../text/index.js";
import { useScreener, useScreenerBeside } from "../contract.js";

export function Empty({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const model = useScreener();
  const { facts } = useScreenerBeside();
  const { commands, host, plan } = useFrame();
  const count = view.rows.length + view.decided.length;
  const empty = emptyOf(view.segment, model, facts, count);
  if (empty.kind === "rows") return null;
  if (empty.kind === "loading") return <KitEmpty label={t("place.loading")} />;
  if (empty.kind === "withheld")
    return <ListLine>{t(empty.why === "listing" ? "emptyListing" : "emptyImporting")}</ListLine>;
  const notYet = view.segment === "waiting" ? facts.notOrganizingYet : null;
  const first = notYet?.mailboxes[0];
  /* The press that changes it, by the first such mailbox: never agreed is the first run's question again for it;
     handed back or stopped, consent stands and the press is Organize here, in Mailboxes. */
  const press =
    first === undefined
      ? null
      : (first.why ?? "never_agreed") === "never_agreed"
        ? host.features.stages.firstRun === NONE
          ? null
          : {
              label: t("notYetPress"),
              onPress: () =>
                commands.go({
                  place: "ohbox",
                  stage: { id: "firstRun", words: { how: "again", mailbox: first.id } },
                }),
            }
        : {
            label: t("notOrganizingPress"),
            onPress: () => commands.go({ place: "settings", sub: "mailboxes" }),
          };
  if (notYet !== null && notYet.every) {
    const why = sharedNotOrganizedWhy(notYet);
    const title =
      why === "never_agreed"
        ? "notYetTitle"
        : why === "handed_back"
          ? "handedBackTitle"
          : "notOrganizingTitle";
    return (
      <div role="list">
        <WaitRow
          what={t(title, { count: notYet.mailboxes.length })}
          why={t(why === "never_agreed" ? "notYetWhy" : "notOrganizingWhy")}
          acts={press === null ? [] : [press]}
        />
      </div>
    );
  }
  /* Some mailboxes are organized and some not: the empty queue, then what screens nothing, each said by name. */
  const one = (w: string | undefined) =>
    w === "handed_back" ? "handedBackOne" : w === "stopped" ? "notOrganizingOne" : "notYetOne";
  const some =
    notYet !== null && !notYet.every ? (
      <>
        {notYet.mailboxes.map((m) => (
          <ListLine key={m.id}>{t(one(m.why), { address: displayAddress(m.address) })}</ListLine>
        ))}
        {press !== null ? <ListLine act={{ ...press, quiet: true }} /> : null}
      </>
    ) : null;
  /* Everyone decided: the mark stands in the reading column where there are two, else here. */
  if (view.segment === "waiting")
    return (
      <>
        {plan.columns === 2 ? null : <AllDecided />}
        {some}
      </>
    );
  return <KitEmpty label={t(`place.empty.${view.segment}`)} />;
}

/** Everyone decided: the mark, and the way to the Ohbox where the let-in mail now is. */
export function AllDecided() {
  const t = useText("screener");
  const places = useText("place");
  const { commands } = useFrame();
  return (
    <KitEmpty
      mark="oh"
      label={t("place.empty.waiting")}
      act={{ label: places("ohbox"), onPress: () => commands.go({ place: "ohbox" }) }}
    />
  );
}

/** Is Waiting all decided: read, no row and no decision left, and nothing that says nothing organizes it? */
export function useAllDecided(view: ScreenerView | null): boolean {
  const model = useScreener();
  const { facts } = useScreenerBeside();
  if (view === null || view.segment !== "waiting" || view.open !== null || view.failedOpen !== null)
    return false;
  const count = view.rows.length + view.decided.length;
  if (emptyOf("waiting", model, facts, count).kind !== "empty") return false;
  return facts.notOrganizingYet === null || !facts.notOrganizingYet.every;
}
