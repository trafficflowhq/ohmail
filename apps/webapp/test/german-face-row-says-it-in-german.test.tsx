/** @vitest-environment jsdom */
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, describe } from "vitest";
import { within } from "@testing-library/react";
import { LocaleShell } from "../app/(product)/LocaleShell";
import { fillFrom } from "../app/shell/locale";
import en from "../messages/en.json";
import de from "../messages/de.json";
import {
  installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  scriptSync, sessionFull, syncPage, teardownConfirmEnv, tick,
} from "./fixtures/cloud-confirm-shell";

beforeEach(installConfirmEnv);
afterEach(teardownConfirmEnv);

describe("ohmail's own names on German screens are German", () => {
  it("Settings → General: the face row is labelled in German", async () => {
    scriptSession(sessionFull);
    scriptRefresh(refresh204);
    scriptSync(() => syncPage("German appearance fixture"));
    rememberOwner();
    window.location.hash = "#/settings/general";
    const german = fillFrom(en as never, de as never);
    const container = await mountCloudShell((shell) => createElement(LocaleShell, {
      initialLocale: "de",
      initialMessages: german as never,
      children: shell,
    }));
    await tick(1_000);
    const page = within(container);
    const choices = page.getByRole("group", { name: de.settingsGeneral.lookChoice });
    expect(within(choices).getByRole("button", { name: de.settings.facePaper })).toBeTruthy();
    expect(page.getByText(de.settings.face, { exact: true })).toBeTruthy();
    expect(page.queryByText(en.settings.face, { exact: true })).toBeNull();
    expect(page.queryByRole("group", { name: en.settingsGeneral.lookChoice })).toBeNull();
  });
});
