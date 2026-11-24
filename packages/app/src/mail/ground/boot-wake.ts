"use client";

/**
 * BEING WOKEN, PUT BACK AT BOOT: the sign-in counterpart of the sign-out's revoke, and the words that follow the
 * account's language. Moved from the old shell's two boot effects as they stood; the two doors are the host's own
 * (`host.device.notifications.reconcile`, `.relabel`), because only a shell can reach its worker.
 *
 * Sign-out drops this device's registration; the switches and the system's permission survive it (a preference of
 * the install). So signing back in showed every switch on over no registration, with closed-app notices silently
 * off, until somebody happened to open Settings. Here instead: the ground is mounted exactly once per sign-in.
 *
 * THE TWO EFFECTS ARE TWO ON PURPOSE.
 * 1. THE RECONCILE runs once, as the frame comes up under its scope, and never again for a draw or for a change of
 *    language: a second run would announce this device to the server a second time.
 * 2. THE RELABEL follows the words. The account's language is adopted after the boot, so the reconcile has written
 *    the worker's words in the device's language. It hands the words alone: running the reconcile again there would
 *    work "may draw" out again from the switches, which is how a previous person's surviving registration is armed
 *    again on a shared device.
 *
 * NEVER ON THE DEMO, and the gate is the browser's own answer (`useResolvedDemoMode`), never the flag a page was
 * served with: on a demo page that flag is false for one render, and the effect would have asked the server from the
 * one surface that promises nothing leaves the tab. NOTHING IS ASKED BEFORE THE WORDS ARE THERE: while the catalogue
 * is on its way the sentence reads empty, and an empty sentence must never reach a lock screen.
 */
import { useEffect, useRef } from "react";
import { useResolvedDemoMode } from "@ohmail/app-logic/engine";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { useText } from "../../text/index.js";

/** The name the worker's notices carry, and the key of the one sentence it may draw while the app is closed. */
const TITLE = "ohmail";
const WORDS = "notifyClosedBody";

export function useWakeAtBoot(): void {
  const { host } = useFrame();
  const demo = useResolvedDemoMode();
  const t = useText("settings");
  /* Asked only once the catalogue holds it: a sentence that is still on its way is no fault to report. */
  const body = t.has(WORDS) ? t(WORDS) : "";
  const worded = body !== "";
  const notifications = host.device.notifications;
  const scope = host.session.scope;
  const account = host.session.account;
  /* What an effect reads when it runs: the doors and the words as they stand then. Neither is a reason to run. */
  const now = useRef({ notifications, body });
  now.current = { notifications, body };
  useEffect(() => {
    if (demo || !worded) return;
    const doors = now.current.notifications;
    if (doors !== NONE) void doors.reconcile?.(now.current.body, scope);
  }, [demo, worded, scope, account]);
  useEffect(() => {
    if (demo || !worded) return;
    const doors = now.current.notifications;
    if (doors !== NONE) void doors.relabel?.(TITLE, body, scope);
  }, [demo, worded, body, scope, account]);
}
