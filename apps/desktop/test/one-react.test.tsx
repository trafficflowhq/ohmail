/** @vitest-environment jsdom */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { jsx } from "react/jsx-runtime";
import { IntlProvider, useTranslations } from "use-intl";

/**
 * ONE REACT IN THE ROOT SUITE, whichever trees are installed (@ci: desktop install).
 *
 * The documented setup installs `apps/desktop`'s own lockfile beside the root's. Node resolves a bare
 * specifier from the nearest `node_modules`, so a file here reached the desktop tree's React while
 * `@testing-library/react` and every shared view reached the root's: two Reacts, and every desktop test
 * that renders failed on "Invalid hook call". The root `vitest.config.ts` resolves a desktop file's bare
 * imports as the root does; this file is what notices if that stops. Its imports above are resolved
 * from here, exactly as a desktop source's are, and they must be the root's modules.
 *
 * With the root installed alone there is one tree and the assertions hold trivially; CI runs this file
 * in the desktop job, where both trees are installed, which is the shape that once failed.
 */
/* `__dirname`, not `import.meta.url`: under the jsdom environment the latter is no `file:` URL. */
const ROOT = resolve(__dirname, "../../..");
const fromRoot = createRequire(join(ROOT, "package.json"));
const desktopTree = existsSync(join(ROOT, "apps/desktop/node_modules/react/package.json"));

afterEach(cleanup);

describe("a desktop file's React", () => {
  it(`is the root's copy (the desktop tree is ${desktopTree ? "installed" : "not installed"})`, () => {
    expect(React.useState).toBe(fromRoot("react").useState);
    expect(createRoot).toBe(fromRoot("react-dom/client").createRoot);
    expect(jsx).toBe(fromRoot("react/jsx-runtime").jsx);
  });

  it("drives hooks through a library the desktop tree also carries, rendered by the root's testing library", () => {
    function Greeting() {
      const t = useTranslations("one");
      const [n] = React.useState(1);
      return <p>{t("react", { n })}</p>;
    }
    const { container } = render(
      <IntlProvider locale="en" messages={{ one: { react: "{n} React" } }}>
        <Greeting />
      </IntlProvider>,
    );
    expect(container.textContent).toBe("1 React");
  });
});
