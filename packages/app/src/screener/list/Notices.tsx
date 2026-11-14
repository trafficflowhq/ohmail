/**
 * THE PLACE'S OWN NOTICES, under the head on Waiting, in the kit's one slot: mail held behind a decision already made
 * (Release puts it where those decisions say; Not now lets this exact set go until it changes), and letters ohmail
 * filed to Spam for claiming a company (Review lists them with the claim's own sentence and Put back; OK lets the line
 * go until a newer filing). Each press is the model's own; nothing here moves mail by itself.
 */
import { useState } from "react";
import type { ScreenerView } from "@ohmail/app-logic/screener";
import { NoticeSlot, type NoticeAct, type SlotNotice } from "@ohmail/ui/base";
import { ListLine } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { Claimed } from "../asks/Claimed.js";
import { useScreener } from "../contract.js";

export function Notices({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const { heldRelease: held, impersonationFiled: claimed } = useScreener();
  const [front, setFront] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  if (view.segment !== "waiting") return null;
  const notices: SlotNotice[] = [];
  if (held) {
    /* While a release is on its way Release stands busy and Not now is off (1.0.11 disables both). */
    const release: NoticeAct = {
      label: t("heldReleaseAll", { count: held.total }),
      onPress: () => held.release(),
      busy: held.releasing,
    };
    const dismiss = held.dismiss;
    notices.push({
      id: "held",
      rank: 0,
      title: t("place.heldTitle", { count: held.total }),
      line: held.rulesTotal > 0 ? t("heldReleaseLead", { count: held.rulesTotal }) : undefined,
      /* "Not now" only where the account can keep it: a dismiss that forgets by tomorrow is worse than none. */
      acts: dismiss
        ? [release, { label: t("heldReleaseNotNow"), onPress: dismiss, disabled: held.releasing }]
        : [release],
    });
  }
  if (claimed && claimed.items.length > 0) {
    const review: NoticeAct = {
      label: t(claimed.open ? "impersonationHide" : "impersonationReview"),
      onPress: claimed.toggle,
    };
    /* OK is off while a Put back is on its way: an OK then would hide its refusal for good (1.0.11 disables it). */
    const ok: NoticeAct = {
      label: t("impersonationOk"),
      onPress: claimed.acknowledge,
      disabled: claimed.busy,
    };
    notices.push({
      id: "claimed",
      rank: 1,
      title: t("impersonationFiled", { count: claimed.items.length }),
      line: claimed.said
        ? t(claimed.said === "failed" ? "impersonationFailed" : "impersonationRequested")
        : undefined,
      acts: [review, ok],
    });
  }
  if (notices.length === 0) return null;
  return (
    <>
      <div className="sc-notices">
        <NoticeSlot
          place="bar"
          notices={notices}
          front={front}
          onFront={setFront}
          more={{
            label: t("place.noticesMore", { count: notices.length - 1 }),
            name: t("place.noticesMoreName"),
          }}
          open={open}
          onOpen={setOpen}
        />
      </div>
      {/* Each contact nobody wrote a rule for is named: Release decides that person into the Ohbox. */}
      {held
        ? held.senders.map((s) => (
            <ListLine key={s.sender}>
              {t("heldReleaseContactLine", { count: s.count, sender: s.sender })}
            </ListLine>
          ))
        : null}
      {claimed && claimed.items.length > 0 ? <Claimed notice={claimed} /> : null}
    </>
  );
}
