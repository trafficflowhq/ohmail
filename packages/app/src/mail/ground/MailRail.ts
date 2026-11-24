"use client";

/**
 * THE RAIL'S FOOT, FED FOR THE FRAME'S LIFE: who is signed in with how many mailboxes, Pull new mail, and the quiet tool
 * beside the account. It is no place's, so it is fed apart from the places (`useRailFoot`), by the ground, which holds
 * the account's mailboxes and the sync. A headless feeder: it draws no node. Moved from today's feed (its rail's foot)
 * with the mends the frame's measure named: the account's line names the person (a mailbox's own name, its address only
 * where it has none) and the count of mailboxes under it, and the scheme's one-press switch stands beside it, as the
 * demo's foot has them.
 *
 * THE ACCOUNT'S LINE leads to Settings' Mailboxes where this host's Settings lists that section, as today's and the
 * demo's do; where it does not list it yet, to the first section it does list (`settingsSection`), never to a
 * section that is not there. It is withheld where the host hands no Settings or no identity is known yet: a line in
 * the foot always takes a press. The way out of the account is not in the foot: it is Settings' Account section.
 *
 * PULL NEW MAIL is the one binding the ground holds (`PullMount`, handed by `PullContext`): single flight, its outcome
 * said in the frame's one report slot. Its key `p` is bound here, beside the button it presses.
 *
 * The command palette's tool is offered by hosts that register the palette.
 */
import { confirmedAccountForScope } from "../../host/session.js";
import { useContext, useMemo } from "react";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { chordKeys, useKeyBindings, useModGlyph } from "@ohmail/app-logic/keys";
import { PullContext, type PullBinding } from "@ohmail/app-logic/session/pull-new-mail";
import { useOptionalTheme } from "@ohmail/ui/theme";
import { useFrame, useRailFoot, type RailFootModel } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { PALETTE_CHORD } from "../../palette/index.js";
import { useText } from "../../text/index.js";
import { settingsSection } from "../../settings/menu.js";

/** The foot's account line over the account's mailboxes, or null while it is withheld. */
function useAccountLine(): RailFootModel["account"] {
  const { host, commands } = useFrame();
  const t = useText("rail");
  const { mailboxes } = useMailState();
  const settings = host.features.places.settings !== NONE;
  return useMemo(() => {
    const first = mailboxes?.[0];
    const { accountAddress } = host.session;
    const address = first?.address || (confirmedAccountForScope(host) !== null ? accountAddress : null);
    if (!settings || !address) return null;
    return {
      name: first?.displayName?.trim() || address,
      address,
      note: mailboxes ? t("mailboxCount", { count: mailboxes.length }) : "",
      title: t("mailboxes"),
      /* Read at the press: what the menu lists follows the host's answers as they stand then. A Settings place this
         entry did not make says nothing of its sections, and is asked for Mailboxes by name. */
      onPress: () =>
        commands.go({ place: "settings", sub: settingsSection(host, "mailboxes") ?? "mailboxes" }),
    };
  }, [mailboxes, settings, t, commands, host]);
}

/** The scheme's one-press switch, where the host stands a theme: to the other of light and dark. */
function useSchemeTool(): NonNullable<RailFootModel["tools"]>[number] | null {
  const t = useText("settings");
  const theme = useOptionalTheme();
  const resolved = theme?.resolved;
  const setTheme = theme?.setTheme;
  return useMemo(() => {
    if (resolved === undefined || setTheme === undefined) return null;
    const dark = resolved === "dark";
    return {
      icon: dark ? "sun" : "moon",
      label: t(dark ? "themeLight" : "themeDark"),
      onPress: () => setTheme(dark ? "light" : "dark"),
    };
  }, [resolved, setTheme, t]);
}

/** Where no binding stands above (a foot fed alone): nothing to pull. */
const NO_PULL: PullBinding = { available: false, pulling: false, pull: () => undefined };

/** The foot as the ground feeds it. */
export function useMailRailFoot(): RailFootModel {
  const { host, commands } = useFrame();
  const ts = useText("sync");
  const tp = useText("palette");
  const mod = useModGlyph();
  const hasPalette = host.features.overs.palette !== NONE;
  /* The ground's one binding (`PullMount`): the foot, its key and the places' pulls are one flight. */
  const binding = useContext(PullContext) ?? NO_PULL;
  /* Its key, as the shipped shell bound it: listed always, resting where pulling is not offered or one is out. */
  const keys = useText("shortcuts");
  useKeyBindings(
    [
      {
        chord: "p",
        group: "app",
        label: keys("pull"),
        disabled: !binding.available || binding.pulling,
        run: () => binding.pull(),
      },
    ],
    "global",
  );
  const account = useAccountLine();
  const row = binding.result?.mailboxId;
  const scheme = useSchemeTool();
  return useMemo(() => {
    const tools: NonNullable<RailFootModel["tools"]>[number][] = [];
    if (hasPalette) {
      const keyHint = chordKeys(PALETTE_CHORD, mod).join(" ");
      tools.push({
        icon: "command",
        label: `${tp("ariaLabel")} · ${keyHint}`,
        keyHint,
        onPress: () => commands.over("palette"),
      });
    }
    if (scheme) tools.push(scheme);
    return {
      account,
      pull: binding.available
        ? {
            label: ts(binding.pulling ? "pulling" : (binding.result?.key ?? "pull")),
            busy: binding.pulling,
            onPress: row
              ? () => commands.go({ place: "settings", sub: "mailboxes", words: { mailbox: row } })
              : binding.pull,
          }
        : null,
      ...(tools.length ? { tools } : {}),
    };
  }, [
    account,
    binding.available,
    binding.pulling,
    binding.pull,
    binding.result,
    row,
    scheme,
    ts,
    tp,
    mod,
    hasPalette,
    commands,
  ]);
}

/** The foot's feeder, standing in the ground for the frame's life. */
export function MailRail(): null {
  useRailFoot(useMailRailFoot());
  return null;
}
