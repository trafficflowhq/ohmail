/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { mailPanes, NO_PANE_PARTS } from "@ohmail/app/mail";
import { useFrame } from "@ohmail/app/frame";
import { NONE, type FeatureEntry } from "@ohmail/app/host";
import { paneOf } from "../../../packages/app/src/settings/facts.js";
import type { SettingsBeside, SettingsPanes } from "../../../packages/app/src/settings/contract.js";
import { settingsPlace } from "../../../packages/app/src/settings/place.js";
import { fakeHost, NO_ENGINE } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress } from "../../../packages/app/test/support/fake-window.js";
import { MailFrame } from "../app/shell/browser-mail";
import messages from "../messages/en.json";
import { afterEach, describe, expect, it } from "vitest";

interface Sections {
  desktopSection?: { label: string; node: ReactNode };
  billingSection?: ReactNode;
  securitySection?: ReactNode;
  accountSection?: ReactNode;
  aboutSection?: ReactNode;
}

const offered = (name: FeatureEntry["name"], node: ReactNode): FeatureEntry => ({ name, render: () => node });

function useSettingsNavigation(): SettingsBeside {
  const { commands } = useFrame();
  return { go: (id) => commands.go({ place: "settings", sub: id }), startAt: null };
}

function mount({ desktopSection, billingSection, securitySection, accountSection, aboutSection }: Sections = {}) {
  const panes: SettingsPanes = {
    ...mailPanes({
      ...NO_PANE_PARTS,
      general: () => null,
      tags: () => null,
      desktop: desktopSection ? () => desktopSection.node : NONE,
      billing: billingSection ? () => billingSection : NONE,
      about: aboutSection ? () => aboutSection : NONE,
    }),
    security: securitySection ? paneOf("security", { Body: () => securitySection }) : NONE,
    account: accountSection ? paneOf("account", { Body: () => accountSection }) : NONE,
  };
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "settings-test",
    address: fakeAddress("#/settings/general"),
    places: { settings: settingsPlace(panes, useSettingsNavigation) },
    features: {
      desktop: desktopSection ? offered("desktop", desktopSection.node) : NONE,
      subscription: billingSection ? offered("subscription", billingSection) : NONE,
      security: securitySection ? offered("security", securitySection) : NONE,
      account: accountSection ? offered("account", accountSection) : NONE,
      about: aboutSection ? offered("about", aboutSection) : NONE,
    },
  });
  const words = desktopSection
    ? { ...messages, settingsMenu: { ...messages.settingsMenu, desktop: desktopSection.label } }
    : messages;
  hostElement = render(
    <NextIntlClientProvider locale="en" messages={words} timeZone="UTC">
      <ThemeProvider><ToastHost><MailFrame host={host} /></ToastHost></ThemeProvider>
    </NextIntlClientProvider>,
  ).container;
}

let hostElement: HTMLElement;
const nav = () => screen.getByRole("navigation", { name: messages.settings.navAria });
const navLabels = () => within(nav()).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim());

afterEach(cleanup);

describe("Settings → the desktop pane", () => {
  it("offers no such pane to a browser tab", async () => {
    mount();
    expect(navLabels()).not.toContain("This install");
    expect(navLabels()).not.toContain(messages.settingsMenu.desktop);
    // …and not merely hidden behind a nav entry nobody clicks: the words are nowhere.
    expect(hostElement.textContent).not.toMatch(/On this Mac|Switch…/);
  });

  it("offers it — under the label the shell supplied — when a shell hands one in", async () => {
    mount({
      desktopSection: {
        label: "This install",
        node: <p>Connected through On this Mac</p>,
      },
    });
    expect(navLabels()).toContain("This install");

    // It is not the pane on screen until it is chosen — General still is.
    expect(screen.queryByText("Connected through On this Mac")).toBeNull();
    fireEvent.click(within(nav()).getByRole("button", { name: "This install" }));
    expect(screen.getByText("Connected through On this Mac").textContent).toBe("Connected through On this Mac");
  });

  /**
   * IT OPENS THE ACCOUNT-ADMINISTRATION GROUP.
   *
   * On the desktop this IS the account: there is no Subscription, no Security and no Account
   * pane, and the door, the mailbox and the sign-out live here instead. Its position is therefore
   * a claim about what it is, not a layout preference — after the panes that organise mail, before
   * the three that need a server.
   */
  it("sits after the mail panes and before the ones that need a server", async () => {
    mount({
      desktopSection: { label: "This install", node: <p>x</p> },
      billingSection: <p>billing</p>,
      securitySection: <p>security</p>,
      accountSection: <p>account</p>,
      aboutSection: <p>about</p>,
    });
    const labels = navLabels();
    expect(labels.indexOf("This install")).toBeGreaterThan(labels.indexOf("Tags"));
    expect(labels.indexOf("This install")).toBeLessThan(labels.indexOf("Subscription"));
    expect(labels.indexOf("This install")).toBeLessThan(labels.indexOf("Account"));
  });
});
