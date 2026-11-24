import { useEffect, useState } from "react";
import type { NoticeAct } from "@ohmail/ui/base";
import { NONE } from "../host/contract.js";
import { useText } from "../text/index.js";
import type { ConnectionFeed } from "./commands.js";
import { useConnectionNotice } from "./connection.js";
import type { FrameCommands, FrameHost } from "./contract.js";
import { useSignal, type Feed } from "./feeds.js";
import { noticeId, type NoticeStore } from "./notice-store.js";

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
  const [hidden, setHidden] = useState<string>();
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
      mailboxes: () =>
        commands.go({
          place: "settings",
          sub: "mailboxes",
          words: fed.mail?.mailboxId ? { mailbox: fed.mail.mailboxId } : {},
        }),
      help: () => commands.go({ place: "settings", sub: "help" }),
      follow: fed.follow,
      ...(setup !== null ? { connect: () => fed.follow(setup) } : {}),
    },
    fed.reason ?? null,
  );
  const id = notice ? noticeId(notice) : undefined;
  useEffect(() => {
    if (id !== undefined) setHidden((was) => (was === id ? was : undefined));
  }, [id]);
  useEffect(() => {
    if (!notice || id === hidden) {
      notices.post("connection", []);
      return;
    }
    const hide: NoticeAct = { label: t("notice.hide"), kind: "quiet", onPress: () => setHidden(id) };
    const first = notice.acts?.[0];
    notices.post("connection", [{ ...notice, more: undefined, acts: first ? [first, hide] : [hide] }]);
  });
  return null;
}
