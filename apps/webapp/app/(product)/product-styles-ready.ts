let ready: Promise<boolean> | undefined;
let fail: (() => void) | undefined;

function isProductStylesheet(link: unknown): link is HTMLLinkElement {
  return link instanceof HTMLLinkElement && link.rel === "stylesheet" && Boolean(link.href) &&
    new URL(link.href).pathname.startsWith("/_next/static/css/");
}

export function failProductStyles() {
  fail?.();
}

/** The browser reports applied sheets separately from Next resolving their module imports. */
export function productStylesReady() {
  return ready ??= new Promise<boolean>((resolve) => {
    function finish(loaded: boolean) {
      document.removeEventListener("load", check, true);
      document.removeEventListener("error", failed, true);
      fail = undefined;
      resolve(loaded);
    }

    function check() {
      const canvas = getComputedStyle(document.body);
      if (!canvas.getPropertyValue("--mailbox-layout-loaded") ||
          !canvas.getPropertyValue("--font-ui") || canvas.boxSizing !== "border-box") return;
      const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
      if (links.some((link) => isProductStylesheet(link) && !link.sheet)) return;
      finish(true);
    }

    function failed(event: Event) {
      if (isProductStylesheet(event.target)) finish(false);
    }

    fail = () => finish(false);
    document.addEventListener("load", check, true);
    document.addEventListener("error", failed, true);
    check();
  });
}
