/** @vitest-environment jsdom */
import { useTheme } from "@ohmail/ui/theme";
import { armSchemeTransitions } from "@ohmail/ui";
import { act, cleanup, render } from "@testing-library/react";
import { useContext, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppearanceBoot, Providers } from "../../app/(product)/providers";
import { ConfirmBrowserFaceOwner } from "../../app/(product)/confirm-browser-face-owner";
import { postSessionChange } from "../../app/signed-out-signal";

const theme = vi.hoisted(() => ({
  storage: undefined as ComponentProps<typeof import("@ohmail/ui").ThemeProvider>["storage"],
}));

vi.mock("@ohmail/ui", async (load) => {
  const ui = await load<typeof import("@ohmail/ui")>();
  return {
    ...ui,
    ThemeProvider(props: ComponentProps<typeof ui.ThemeProvider>) {
      theme.storage = props.storage;
      return <ui.ThemeProvider {...props} />;
    },
  };
});

const ACCOUNT = "returning-account";
const OTHER = "another-account";
const MIRROR = "ohmail.face.account";
const OWNER = "ohmail.face.account.owner";

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  document.cookie = `tf_owner=${ACCOUNT}; Path=/`;
  localStorage.setItem(MIRROR, "ohmarchy");
  localStorage.setItem(OWNER, ACCOUNT);
});

afterEach(() => {
  cleanup();
  theme.storage = undefined;
  vi.restoreAllMocks();
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  localStorage.clear();
  delete document.documentElement.dataset.face;
});

function firstFace(owner: string | null) {
  const body = document.createElement("template");
  body.innerHTML = renderToStaticMarkup(<AppearanceBoot owner={owner} deferLinuxFace />);
  for (const script of body.content.querySelectorAll("script")) new Function(script.textContent ?? "")();
  return document.documentElement.dataset.face ?? "paper";
}

it("applies a new scheme while the browser's controls stay available", () => {
  const startViewTransition = vi.fn((apply: () => void) => apply());
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: startViewTransition });
  function Probe() {
    const { setTheme } = useTheme();
    return <button onClick={() => setTheme("dark")}>Dark</button>;
  }
  try {
    const { getByRole } = render(<Providers><Probe /></Providers>);
    armSchemeTransitions();
    act(() => { getByRole("button", { name: "Dark" }).click(); });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("scheme-shift")).toBe(true);
    expect(startViewTransition).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(document, "startViewTransition");
    delete document.documentElement.dataset.theme;
  }
});

it("uses the confirmed account's saved face in the document head", () => {
  expect(firstFace(ACCOUNT)).toBe("ohmarchy");
});

it("starts the signed-out Linux sign-in document on paper with a previous account in storage", () => {
  document.cookie = "tf_owner=signed_out_pending; Path=/";
  expect(firstFace(null)).toBe("paper");
});

it("starts on paper when the browser has switched accounts since the page was served", () => {
  document.cookie = "tf_owner=another-account; Path=/";
  expect(firstFace(ACCOUNT)).toBe("paper");
});

it("leaves the new account's saved face alone when the previous page adopts its own consent", () => {
  let adopt!: ReturnType<typeof useTheme>["adoptAccountFace"];
  function Probe() {
    adopt = useTheme().adoptAccountFace;
    return null;
  }
  render(<Providers owner={ACCOUNT} deferLinuxFace><Probe /></Providers>);

  document.cookie = "tf_owner=another-account; Path=/";
  localStorage.setItem(OWNER, "another-account");
  act(() => { adopt("paper"); });
  expect(localStorage.getItem(MIRROR)).toBe("ohmarchy");
  act(() => { adopt(null); });
  expect(localStorage.getItem(MIRROR)).toBe("ohmarchy");
});

it("discards the account marker when the account changes during the face write", () => {
  render(<Providers owner={ACCOUNT} deferLinuxFace>{null}</Providers>);
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key === MIRROR) {
      document.cookie = `tf_owner=${OTHER}; Path=/`;
      setItem.call(this, OWNER, OTHER);
    }
    setItem.call(this, key, value);
  });
  expect(theme.storage!.set(MIRROR, "paper")).toBe("lost");
  expect(localStorage.getItem(OWNER)).toBeNull();
});

it.each(["face", "account"])("discards the stamp when the %s changes as the stamp is written", (changed) => {
  render(<Providers owner={ACCOUNT} deferLinuxFace>{null}</Providers>);
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key === OWNER) {
      if (changed === "face") setItem.call(this, MIRROR, "ohmarchy");
      else document.cookie = `tf_owner=${OTHER}; Path=/`;
    }
    setItem.call(this, key, value);
  });
  expect(theme.storage!.set(MIRROR, "paper")).toBe("lost");
  expect(localStorage.getItem(OWNER)).toBeNull();
});

it("adopts a confirmed owner's face only when the live browser account matches", () => {
  let confirm!: (owner: string) => void;
  let look!: ReturnType<typeof useTheme>;
  function Probe() {
    confirm = useContext(ConfirmBrowserFaceOwner);
    look = useTheme();
    return null;
  }
  document.cookie = `tf_owner=${OTHER}; Path=/`;
  render(<Providers deferLinuxFace><Probe /></Providers>);
  act(() => { confirm(ACCOUNT); });
  expect(document.documentElement.dataset.face).toBeUndefined();
  expect(look.accountFace).toBeNull();

  // A late adoption also must stay off the page while this confirmation is out of scope.
  act(() => { look.adoptAccountFace("ohmarchy"); });
  expect(document.documentElement.dataset.face).toBeUndefined();
  expect(look.accountFace).toBeNull();

  act(() => {
    document.cookie = `tf_owner=${ACCOUNT}; Path=/`;
    postSessionChange();
  });
  expect(look.accountFace).toBe("ohmarchy");
  expect(document.documentElement.dataset.face).toBe("ohmarchy");
});

it("keeps the remembered face during session confirmation and saves the confirmed account's new choice", () => {
  let confirm!: (owner: string) => void;
  let look!: ReturnType<typeof useTheme>;
  function Probe() {
    confirm = useContext(ConfirmBrowserFaceOwner);
    look = useTheme();
    return null;
  }
  localStorage.setItem(MIRROR, "paper");
  localStorage.setItem("ohmail.face", "ohmarchy");
  render(<Providers rememberedOwner={null} deferLinuxFace><Probe /></Providers>);
  expect(look.face).toBe("paper");
  act(() => { look.adoptAccountFace("ohmarchy"); });
  expect(localStorage.getItem(MIRROR)).toBe("paper");

  act(() => { confirm(ACCOUNT); });
  act(() => { look.adoptAccountFace("ohmarchy"); });
  expect(document.documentElement.dataset.face).toBe("ohmarchy");
  expect(localStorage.getItem(MIRROR)).toBe("ohmarchy");
  expect(localStorage.getItem(OWNER)).toBe(ACCOUNT);
  delete document.documentElement.dataset.face;
  expect(firstFace(ACCOUNT)).toBe("ohmarchy");
});

it("leaves a different account's remembered face unused while the session is pending", () => {
  let look!: ReturnType<typeof useTheme>;
  function Probe() {
    look = useTheme();
    return null;
  }
  document.cookie = `tf_owner=${OTHER}; Path=/`;
  localStorage.setItem(OWNER, OTHER);
  render(<Providers rememberedOwner={ACCOUNT} deferLinuxFace><Probe /></Providers>);
  expect(look.face).toBe("paper");
  expect(localStorage.getItem(MIRROR)).toBe("ohmarchy");
});
