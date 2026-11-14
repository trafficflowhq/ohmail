import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { fillOver, TextProvider, type Messages } from "@ohmail/app/text";
import type { QrSlot } from "@ohmail/app/account";
/* The recording server sets the API base as it loads: it is imported before anything that imports the client. */
import { de, en, json } from "./account-harness";
import devicesDe from "../../../../packages/app/messages/account-devices.de.json";
import devicesEn from "../../../../packages/app/messages/account-devices.en.json";
import invitesDe from "../../../../packages/app/messages/account-invites.de.json";
import invitesEn from "../../../../packages/app/messages/account-invites.en.json";
import { QrCode } from "../../app/shell/QrCode";
import { decodeQr, matrixFromSvg } from "../fixtures/qr-decode";

/**
 * WHAT THE CASES OF SETTINGS › DEVICES AND › INVITES ADD to the account panes' recording server: the two panes'
 * own place files beside the shell's catalogue (until the catalogue holds them), the picture of a link as the shell
 * draws it today, read back from the page, the handshake's answer, and a clipboard that is watched.
 */

const EN = { ...en, ...devicesEn, ...invitesEn } as Messages;
const TEXT: Readonly<Record<"en" | "de", Messages>> = {
  en: EN,
  de: fillOver(EN, { ...de, ...devicesDe, ...invitesDe } as Messages),
};

/** The readers of words the shell mounts: the framework's, which a filling and a shipped section read, and the app's. */
export function Words({
  lang = "en",
  children,
}: {
  readonly lang?: "en" | "de";
  readonly children: ReactNode;
}) {
  return (
    <NextIntlClientProvider locale={lang} messages={lang === "en" ? en : de} timeZone="UTC">
      <TextProvider locale={lang} messages={TEXT[lang]} timeZone="UTC">
        <ThemeProvider>
          <ToastHost>{children}</ToastHost>
        </ThemeProvider>
      </TextProvider>
    </NextIntlClientProvider>
  );
}

/** The picture slot as the web fills it until the kit draws one: today's picture of a link. */
export const qr: QrSlot = (value, label) => <QrCode value={value} ariaLabel={label} />;

/** What the one picture on the page says to a camera; `null` where no picture is drawn. */
export function scanned(): string | null {
  const picture = document.querySelector<SVGSVGElement>('svg[role="img"]');
  return picture === null ? null : decodeQr(matrixFromSvg(picture));
}

/** The handshake's answer of a server of one flavour that pairs. */
export const hello = (flavor: string): Response =>
  json({
    product: "ohmail",
    flavor,
    apiVersion: "0.0.0",
    needsSetup: false,
    auth: { password: true, totp: true, webauthn: true, publicSignup: false },
    features: { sse: true, staging: true, ai: true, pairing: true },
  });

/** The clipboard, watched: what it was handed, and whether it takes it. */
export function watchClipboard(takes = true) {
  const written: string[] = [];
  const real = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        written.push(text);
        return takes ? Promise.resolve() : Promise.reject(new Error("the clipboard refused"));
      },
    },
  });
  return {
    written,
    restore() {
      if (real) Object.defineProperty(navigator, "clipboard", real);
      else Reflect.deleteProperty(navigator, "clipboard");
    },
  };
}
