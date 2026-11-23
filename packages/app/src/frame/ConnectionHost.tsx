import { useEffect, useState } from "react";
import type { NoticeAct } from "@ohmail/ui/base";
import { NONE } from "../host/contract.js";
import { useText } from "../text/index.js";
import type { ConnectionFeed } from "./commands.js";
import { useConnectionNotice } from "./connection.js";
import type { FrameCommands, FrameHost, FrameNotice } from "./contract.js";
import { useSignal, type Feed } from "./feeds.js";
import type { NoticeStore } from "./notice-store.js";

const NO_SIGNAL = { read: () => null, subscribe: () => () => undefined };

/** The connection, read off the host and today's views, said in the one slot. */
export function ConnectionHost({
  host,
  feed,
  notices,
  commands,
}: {
  host: FrameHost;
  feed: Feed<ConnectionFeed>;
  notices: NoticeStore;
  commands: FrameCommands;
}) {
  const t = useText("frame");
  const [hidden, setHidden] = useState<FrameNotice["kind"]>();
  const fed = useSignal(feed);
  const quiet = useSignal(host.signals.hostConnection === NONE ? NO_SIGNAL : host.signals.hostConnection);
  const setup = fed.setupHref;
  const notice = useConnectionNotice(
    {
      mail: fed.mail,
      online: fed.online,
      session: host.session.state,
      host: quiet,
      copyAsOf: fed.copyAsOf ?? null,
    },
    {
      recover: host.session.recover,
      mailboxes: () => commands.go({ place: "settings", sub: "mailboxes" }),
      help: () => commands.go({ place: "settings", sub: "help" }),
      follow: fed.follow,
      ...(setup !== null ? { connect: () => fed.follow(setup) } : {}),
    },
    fed.reason ?? null,
  );
  const kind = notice?.kind;
  useEffect(() => {
    if (kind !== undefined) setHidden((was) => (was === kind ? was : undefined));
  }, [kind]);
  useEffect(() => {
    if (!notice || kind === hidden) {
      notices.post("connection", []);
      return;
    }
    if (kind === "late" || kind === "behind" || kind === "firstSync" || kind === "filing") {
      const hide: NoticeAct = { label: t("notice.hide"), kind: "quiet", onPress: () => setHidden(kind) };
      const first = notice.acts?.[0];
      notices.post("connection", [{ ...notice, more: undefined, acts: first ? [first, hide] : [hide] }]);
      return;
    }
    notices.post("connection", [notice]);
  });
  return null;
}
