import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A REFUSED STARTTLS UPGRADE CARRIES ITS REASON ON THE CLOSE — the Android transport patch's half
 * of naming a refused certificate at Connect, read statically: no JVM runs it here, and the device
 * check is `tls-transport-guards.sh`. The patched `startTLS` used to close with no reason and
 * rethrow, so the module's catch sent the reason as an `error` AFTER the `close` — to a JavaScript
 * socket the library had already unregistered (`Socket.js` `_setDisconnected`). The certificate
 * never reached the shim. The implicit-TLS dial's failure does reach the module's catch, which
 * sends its message alone: for a chain refused under a trusted root that is "Chain validation
 * failed", and the certificate's reason is only in the causes.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const PATCH_FILE = "react-native-tcp-socket@6.4.2.patch";
const PATCH = readFileSync(join(REPO, "patches", PATCH_FILE), "utf8");
const MARKER = "the TLS upgrade failed: ";
const DIAL_MARKER = "the TLS handshake failed: ";
const JAVA = "android/src/main/java/com/asterinet/react/tcpsocket";

/** `TcpSocketClient.java` as the patch's hunks leave it: added and kept lines. */
function patchedClient(): string {
  const start = PATCH.indexOf(`diff --git a/${JAVA}/TcpSocketClient.java`);
  const end = PATCH.indexOf("diff --git", start + 1);
  return PATCH.slice(start, end === -1 ? undefined : end).split("\n")
    .filter((l) => (l.startsWith("+") || l.startsWith(" ")) && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}

/** One method, from its signature to its matching brace. */
function method(source: string, signature: string): string {
  const at = source.indexOf(signature);
  if (at === -1) return "";
  let depth = 0;
  for (let i = source.indexOf("{", at); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(at, i + 1);
  }
  return "";
}

const installed = (file: string): string => {
  const pkg = createRequire(join(REPO, "apps", "mobile", "package.json")).resolve("react-native-tcp-socket/package.json");
  return readFileSync(join(dirname(pkg), JAVA, file), "utf8");
};

/** The literals the dex check asks of an APK for this patch (`apply-patches.mjs markers`). */
function markers(): string[] {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "apply-patches.mjs"), "markers", "--json"], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  const table = JSON.parse(r.stdout) as Record<string, { markers: string[] }>;
  return table[PATCH_FILE]?.markers ?? [];
}

describe("the transport patch's failed upgrade", () => {
  it("closes the connection and carries the failure on the close, never rethrowing it", () => {
    const body = method(patchedClient(), "public void startTLS(");
    expect(body, "the patch has no startTLS").not.toBe("");
    const caught = /catch \(final Exception (\w+)\) \{([\s\S]*?)\n {8}\}/.exec(body);
    expect(caught, "the upgrade's failure is not caught").not.toBeNull();
    expect(caught![2]).toContain(`failure = ${caught![1]};`);
    expect(caught![2], "a rethrown failure reaches the module's catch, after the close").not.toMatch(/\bthrow\b/);
    expect(body).toContain("closed = true;");
    expect(body).toContain("socket.close();");
    expect(body).toContain("receiverListener.onClose(getId(), failure == null ? null : upgradeFailure(failure));");
    expect(body, "the close still carries no reason").not.toContain("receiverListener.onClose(getId(), null);");
  });

  it("says why in words the build can be checked for, with every cause under it", () => {
    const helper = method(patchedClient(), "private static IOException upgradeFailure(");
    expect(helper).toContain(`"${MARKER}"`);
    expect(helper).toContain("withCauses(");
    expect(method(patchedClient(), "private static IOException withCauses("), "the causes are not walked").toContain("getCause()");
    expect(markers(), "the dex check cannot see the change").toContain(MARKER);
    expect(installed("TcpSocketClient.java"), "the installed copy is not this patch's").toContain(MARKER);
  });

  /* THE PREMISE: the library's own listener emits a close's exception as `error` BEFORE the `close`. */
  it("rides the library's close, which says the error first", () => {
    const onClose = method(installed("TcpEventListener.java"), "public void onClose(int id, Exception e)");
    expect(onClose.indexOf("onError(id, e);"), "the library's close no longer says the error").toBeGreaterThan(-1);
    expect(onClose.indexOf("onError(id, e);")).toBeLessThan(onClose.indexOf('sendEvent("close"'));
  });
});

describe("the transport patch's refused implicit-TLS dial", () => {
  it("closes the connection and throws the failure with every cause in its message", () => {
    const body = method(patchedClient(), "public void connect(");
    expect(body, "the patch has no connect").not.toBe("");
    const caught = /try \{\s*secure\.startHandshake\(\);\s*\} catch \(final Exception (\w+)\) \{([\s\S]*?)\n {12}\}/.exec(body);
    expect(caught, "the implicit-TLS handshake's failure is not caught").not.toBeNull();
    expect(caught![2]).toContain("socket.close();");
    expect(caught![2], "the module's catch hears the message alone").toContain(`throw handshakeFailure(${caught![1]});`);
    expect(body.match(/startHandshake\(\)/g), "a handshake outside the catch").toHaveLength(1);
  });

  it("says why behind a literal of its own, which the dex check reads", () => {
    const helper = method(patchedClient(), "private static IOException handshakeFailure(");
    expect(helper).toContain(`"${DIAL_MARKER}"`);
    expect(helper).toContain("withCauses(");
    expect(markers(), "the dex check cannot see the change").toContain(DIAL_MARKER);
    expect(installed("TcpSocketClient.java"), "the installed copy is not this patch's").toContain(DIAL_MARKER);
  });

  /* THE PREMISE: a failed dial reaches the module's catch, and `onError` sends its message alone. */
  it("rides the module's connect catch, which sends the message alone", () => {
    const connect = method(installed("TcpSocketModule.java"), "public void connect(");
    expect(connect, "the module's connect no longer reports a failed dial as onError").toMatch(/catch \(Exception e\) \{\s*tcpEvtListener\.onError\(cId, e\);/);
    const onError = method(installed("TcpEventListener.java"), "public void onError(int id, Exception e)");
    expect(onError).toContain("String error = e.getMessage();");
  });
});
