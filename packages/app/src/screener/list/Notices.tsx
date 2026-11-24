/** The Screener notices that need attention on Waiting. */
import { useState } from "react";
import type { ScreenerView } from "@ohmail/app-logic/screener";
import { NoticeSlot, type NoticeAct, type SlotNotice } from "@ohmail/ui/base";
import { useFrame } from "../../frame/commands.js";
import { useText } from "../../text/index.js";
import { Claimed } from "../asks/Claimed.js";
import { useScreener, useScreenerBeside } from "../contract.js";

export function Notices({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const { windowNotice } = useScreenerBeside();
  const { impersonationFiled: claimed, unscreened, role } = useScreener();
  const { commands } = useFrame();
  const [front, setFront] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  if (view.segment !== "waiting") return null;
  const notices: SlotNotice[] = [];
  if (role.oauthOnly) {
    notices.push({
      id: "oauth",
      rank: 0,
      title: t(role.name === null ? "oauthDeciderUnknown" : "oauthDecider", { name: role.name ?? "" }),
      line: t("oauthDecideElsewhere"),
      acts: [
        {
          label: t("readerBarOpenMailboxes"),
          onPress: () => commands.go({ place: "settings", sub: "mailboxes" }),
        },
      ],
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
  if (windowNotice) {
    const { state, holderName } = windowNotice;
    const key = state === "unread" ? "unread" : "unstated";
    notices.push({
      id: "screening-window",
      rank: 2,
      title: t("place.windowNotice.title"),
      line:
        holderName === null
          ? t(`place.windowNotice.${key}Unknown`)
          : t(`place.windowNotice.${key}`, { holder: holderName }),
    });
  }
  if (unscreened) {
    notices.push({
      id: "undecided",
      rank: 3,
      title: t(unscreened.atLeast ? "unscreenedLeadAtLeast" : "unscreenedLead", { count: unscreened.total }),
      acts: [
        {
          label: t("unscreenedAll", { count: unscreened.total }),
          onPress: () => unscreened.screen(),
          busy: unscreened.screening,
        },
      ],
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
      {claimed && claimed.items.length > 0 ? <Claimed notice={claimed} /> : null}
    </>
  );
}
