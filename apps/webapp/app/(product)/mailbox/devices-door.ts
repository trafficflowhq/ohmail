"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFormatter } from "next-intl";
import type { Answer, DeviceKind, DeviceName, DeviceSession, DevicesDoor } from "@ohmail/app/account";
import { ApiError, devices as devicesApi, pair, type DeviceDTO } from "../../api-client";
import { ALLOWED_API_ORIGINS } from "../../api-origin";
import { SELF_HOST_BUILD, serverHello } from "../../hello";
import { useRefusalSentence } from "../refusal-sentence";
import { securityRefusal } from "./security-door";

/** How this door says a day and a time of day: the product's one formatter, handed in by the shell. */
export interface DevicesSaid {
  day(iso: string): string;
  /** A five-minute code's deadline is a time: its date would be today. */
  clock(iso: string): string;
}

/** The name the server stores for a desktop app that paired without one (the auth service's own list). */
const MINTED_LABEL: Readonly<Partial<Record<DeviceDTO["kind"], string>>> = {
  macos: "ohmail for Mac",
  "desktop-macos": "ohmail for Mac",
  "desktop-linux": "ohmail for Linux",
  "desktop-windows": "ohmail for Windows",
};

/** The server's device vocabulary, as the pane names it. A kind newer than this build is `other`, never a browser. */
function kindOf(kind: DeviceDTO["kind"]): DeviceKind {
  switch (kind) {
    case "web":
      return "web";
    case "macos":
    case "desktop-macos":
      return "mac";
    case "desktop-linux":
      return "linux";
    case "desktop-windows":
      return "windows";
    case "mobile-android":
      return "android";
    case "mobile-ios":
      return "ios";
    default:
      return "other";
  }
}

/** Who named a device: the server's default for its kind is ohmail's word, not the person's; an empty name is nobody's. */
function nameOf(device: DeviceDTO): DeviceName {
  if (MINTED_LABEL[device.kind] === device.label) return { by: "ohmail" };
  return device.label ? { by: "person", said: device.label } : { by: "nobody" };
}

/** One signed-in session as the pane lists it. `named === false` is the server's own word for a plain browser sign-in. */
const sessionOf = (device: DeviceDTO, said: DevicesSaid): DeviceSession => ({
  id: device.id,
  kind: kindOf(device.kind),
  name: nameOf(device),
  current: device.current,
  plainWeb: device.named === false,
  added: said.day(device.createdAt),
  seen: said.day(device.lastSeenAt),
});

/**
 * Where a pairing link points: the origin that answers the API at its root, because the scanning device redeems
 * and then syncs there. On a self-hosted server that is this page's origin; on the managed service it is the one
 * allow-listed API origin, never this page's.
 */
function pairOrigin(): string {
  return SELF_HOST_BUILD ? window.location.origin : ALLOWED_API_ORIGINS[0]!;
}

/**
 * THE WEB'S DEVICES DOOR. The lists are `GET /devices` and `GET /pair`, asked together: a read that failed is said,
 * whatever refused it. A new link (`POST /pair {grant: "device-pair", label?}`), a code revoked (`DELETE /pair/:id`,
 * where 404 is every kind of already gone), a device signed out (`DELETE /devices/:id`) and the other browser
 * sessions ended (`POST /devices/revoke-web-sessions {}`) are each one request, tried as they are: the server
 * decides whether the factor is asked. A refused verb is read as Security's verbs are: the three panes had one rule.
 *
 * The pairing link is assembled here, once, from the one answer that carries its token. The token rides the
 * fragment, which no request carries; it is in no log line and no stored key, and only the link leaves this file.
 */
export function devicesDoor(say: (err: unknown) => string, said: DevicesSaid): DevicesDoor {
  const tried = async <T>(call: () => Promise<T>): Promise<Answer<T>> => {
    try {
      return { ok: true, value: await call() };
    } catch (err) {
      return securityRefusal(err, say);
    }
  };
  return {
    async read() {
      try {
        const [{ items: sessions }, { items: made }] = await Promise.all([devicesApi.list(), pair.list()]);
        // Live pairing codes only: spent and expired rows are history, and invites are the Invites pane's.
        const live = made.filter((code) => code.grant === "device-pair" && code.status === "live");
        return {
          ok: true,
          value: {
            sessions: sessions.map((device) => sessionOf(device, said)),
            codes: live.map((code) => ({
              id: code.id,
              name: code.label || null,
              until: said.clock(code.expiresAt),
            })),
          },
        };
      } catch (err) {
        return { ok: false, word: "said", said: say(err) };
      }
    },
    // One line with one sign-out only where the server mounts that sign-out: the managed service and a self-hosted
    // server. Elsewhere, and where the handshake did not answer, every session keeps its own line.
    async groupsWebSessions() {
      const hello = await serverHello();
      return hello?.flavor === "managed" || hello?.flavor === "selfhost";
    },
    add: (name) =>
      tried(async () => {
        const made = await pair.mintDevice(name ? { label: name } : {});
        return { id: made.id, link: `${pairOrigin()}/pair#${made.token}`, name: made.label };
      }),
    revokeCode: (id) =>
      tried(async () => {
        try {
          await pair.revoke(id);
        } catch (err) {
          // Spent, expired or revoked elsewhere: the row is leaving the list either way.
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
        return null;
      }),
    remove: (id) =>
      tried(async () => {
        await devicesApi.revoke(id);
        return null;
      }),
    signOutWeb: () => tried(async () => ({ ended: (await devicesApi.revokeWebSessions()).revoked })),
    async copy(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The web's Devices door, its refusals, days and times said in the reader's language. */
export function useDevicesDoor(): DevicesDoor {
  const say = useRefusalSentence();
  const format = useFormatter();
  // The door stays one door whatever formatter a draw hands in: a new door would ask both lists again.
  const formatter = useRef(format);
  useEffect(() => {
    formatter.current = format;
  });
  return useMemo(
    () =>
      devicesDoor(say, {
        day: (iso) => formatter.current.dateTime(new Date(iso), { dateStyle: "medium" }),
        clock: (iso) => formatter.current.dateTime(new Date(iso), { timeStyle: "short" }),
      }),
    [say],
  );
}
