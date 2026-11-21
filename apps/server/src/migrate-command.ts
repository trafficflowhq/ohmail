import {
  dataApiPolicyFromEnv, printSetupReport, sealedOpener, setupProdDatabase, setupTargetOf, storeKindOf,
} from "@trafficflow/db/admin";
import { serverConfigOf } from "./config.js";
import { loadSettings, type SettingsDoorInput } from "./settings.js";

/** Provision once with this server's key provider, without constructing its HTTP program. */
export async function migrateCommand(
  argv: readonly string[], env: NodeJS.ProcessEnv, door: SettingsDoorInput,
): Promise<number> {
  try {
    const kind = storeKindOf(argv);
    if (!kind) throw new Error("--store cloud or --store server is required");
    const settings = loadSettings(env, door);
    if (settings.managed !== (kind === "cloud")) {
      throw new Error("--store must match the server's managed or self-hosted configuration");
    }
    if (settings.keyRing.error !== null) throw new Error(settings.keyRing.error);
    const cfg = serverConfigOf(settings);
    const { url, expectedHost } = setupTargetOf(
      env, kind === "cloud" ? env.DATABASE_URL_SESSION : env.DATABASE_URL_SESSION ?? cfg.databaseUrl,
    );
    const report = await setupProdDatabase(url, {
      log: (message) => console.log(`[db:setup:prod] ${message}`),
      expectedHost,
      dataApi: dataApiPolicyFromEnv(env),
      transition: { kind, openSealed: sealedOpener(cfg.keyProvider), verifyExistingSealed: kind === "cloud" },
      ...(argv.includes("--lock") ? { lock: "apply" as const } : {}),
    });
    printSetupReport(report);
    return 0;
  } catch (err: unknown) {
    console.error(`[db:setup:prod] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
