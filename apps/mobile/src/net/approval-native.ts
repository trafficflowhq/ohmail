import { requireOptionalNativeModule } from "expo";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import { challengeOf } from "../switch/digest";
import { APP } from "../variant-native";
import type { ApprovalBrowserExit, BrowserApprovalDeps } from "./approval";

interface SelfHostApprovalBrowser {
  openSelfHostApproval(url: string, cookie: string): Promise<ApprovalBrowserExit>;
  closeSelfHostApproval(): Promise<void>;
}

export function approvalBrowser(selfHosted: boolean): Pick<BrowserApprovalDeps, "open" | "close" | "pkce" | "now" | "sleep"> {
  let dismiss: (() => void) | undefined;
  return {
    async open(url, signal, onClosed, launch) {
      if (selfHosted) {
        const browser = requireOptionalNativeModule<SelfHostApprovalBrowser>("OhmailShell");
        if (signal.aborted || !launch || !browser?.openSelfHostApproval) return false;
        const abort = () => { void browser.closeSelfHostApproval().catch(() => {}); };
        dismiss = () => {
          signal.removeEventListener("abort", abort);
          abort();
        };
        signal.addEventListener("abort", abort, { once: true });
        const cookie = `ohmail_approval_launch=${launch}; Path=/approve; Secure; HttpOnly; SameSite=Strict`;
        void browser.openSelfHostApproval(url, cookie).then(onClosed, () => onClosed("failed"));
        return true;
      }
      const browser = await import("expo-web-browser");
      if (signal.aborted) return false;
      dismiss = () => {
        if (Platform.OS === "ios") browser.dismissAuthSession();
      };
      // Approval is polled. A browser redirect has no authority to sign this app in.
      void browser.openAuthSessionAsync(url, `${APP.scheme}://browser-approval`).then(
        (result) => onClosed(result.type === "locked" ? "failed" : "cancelled"),
        () => onClosed("failed"),
      );
      return true;
    },
    close() {
      try { dismiss?.(); } catch { /* The person already closed the sheet. */ }
    },
    async pkce() {
      const bytes = await Crypto.getRandomBytesAsync(32);
      const verifier = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const challenge = await challengeOf(
        (text) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.BASE64 }),
        verifier,
      );
      return { verifier, challenge };
    },
    now: Date.now,
    sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }),
  };
}
