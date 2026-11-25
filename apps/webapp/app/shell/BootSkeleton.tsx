"use client";

import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button, Opening, RowsShape, openingReloadDelay } from "@ohmail/ui/base";
import { useBrowserOnline } from "@ohmail/app-logic/session/browser-online";
import { useLoadingGrace } from "@ohmail/app-logic/session/loading-grace";
import { OpeningFrame, useSignal } from "@ohmail/app/frame";
import { browserWindowFacts } from "@ohmail/app/host/browser";
import { useThemeLook } from "@ohmail/app/mail";

/** Wait for a slow load before drawing the shape of the mail that's still owed. */
export const BOOT_SKELETON_GRACE_MS = 300;

export function BootSkeleton({ active }: { active: boolean }) {
  const show = useLoadingGrace(active, BOOT_SKELETON_GRACE_MS);
  return show ? <RowsShape within /> : null;
}

/** The shared mail frame before a desktop window has an engine to give it. */
export function WindowOpening({ children }: { children?: ReactNode }) {
  const windowFacts = useMemo(() => browserWindowFacts(window), []);
  const facts = useSignal(windowFacts);
  const look = useThemeLook();
  const show = useLoadingGrace(true, BOOT_SKELETON_GRACE_MS);
  return (
    <div className="gate-boot" aria-busy={children ? undefined : true}>
      <OpeningFrame facts={facts} look={look} show={show} status={children} />
    </div>
  );
}

const noSubscription = () => () => {};

/** The web's quiet opening frame and the way forward when it stays on screen. */
export function MailboxOpening({
  serverFrame = false,
  network = true,
  immediate = false,
}: {
  serverFrame?: boolean;
  network?: boolean;
  immediate?: boolean;
}) {
  const session = useTranslations("session");
  const reload = useTranslations("appError")("reload");
  const online = useBrowserOnline();
  const served = useSyncExternalStore(noSubscription, () => false, () => serverFrame);
  const waiting = useLoadingGrace(!serverFrame);
  const late = useLoadingGrace(!serverFrame, openingReloadDelay);

  if (served) {
    return <Opening kind="web" late immediate={immediate} label={session("opening")} action={<Button kind="two" href="/">{reload}</Button>} />;
  }

  const offerReload = waiting && (late || (network && !online));
  return (
    <Opening
      kind="web"
      label={immediate || waiting ? session("opening") : undefined}
      action={offerReload ? <Button kind="two" onPress={() => window.location.reload()}>{reload}</Button> : undefined}
    />
  );
}
