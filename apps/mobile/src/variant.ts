/**
 * THE TWO PHONE APPS, as one table: ohmail with mail, ohcal with the calendar, and a preview of each that sits beside
 * the released pair on one phone. `variants.json` is the one source: the build's configuration, the native plugins,
 * the app at run time, the page's build and the tests all read it, and this file is its typed reader. It imports the
 * table and nothing else.
 *
 * A row names its sibling, the app its switch opens; a preview's sibling is the other preview, so a preview never
 * opens a released app. Each row has one identifier for both systems.
 */
import table from "../variants.json";

/** A row's name, as the table spells it. */
export type VariantId = keyof typeof table;
/** Which product an app is: the mail or the calendar. A preview is its product's. */
export type AppId = "ohmail" | "ohcal";

export interface VariantRow {
  readonly app: AppId;
  readonly channel: "release" | "preview";
  readonly sibling: VariantId;
  /** The identifier on both systems: Android's package and the iPhone's bundle identifier. */
  readonly id: string;
  readonly name: string;
  readonly scheme: string;
  /** Where the switch's universal link lands on the iPhone: this app's domain, one exact path. */
  readonly links: { readonly host: string; readonly path: string };
  /** The signature permission that guards the switch's door on Android; one name per pair. */
  readonly permission: string;
  /** The authority of this app's switch provider on Android. */
  readonly authority: string;
  readonly carries: {
    /** Today's phone screens ship in this app (the ohmail app's default surface). */
    readonly screens: boolean;
    /** This phone may organize a mailbox on its own: the engine is registered and the standalone door offered. */
    readonly organizes: boolean;
    /** The mail's wake by push is registered. */
    readonly mailPush: boolean;
  };
  /** What the configuration takes out for this app: config plugins and native modules, by name. */
  readonly without: { readonly plugins: readonly string[]; readonly modules: readonly string[] };
  /** The iPhone build declares its associated domain (after the names exist at Apple; the rig may ask for it). */
  readonly iosAssociatedDomains: boolean;
}

function frozen(rows: Record<string, VariantRow>): Readonly<Record<VariantId, VariantRow>> {
  for (const row of Object.values(rows)) {
    Object.freeze(row.links);
    Object.freeze(row.carries);
    Object.freeze(row.without.plugins);
    Object.freeze(row.without.modules);
    Object.freeze(row.without);
    Object.freeze(row);
  }
  return Object.freeze(rows) as Readonly<Record<VariantId, VariantRow>>;
}

export const VARIANTS: Readonly<Record<VariantId, VariantRow>> = frozen(table as Record<string, VariantRow>);

/** The row of an app by its identifier, as the system reports it. An identifier outside the table is a build fault. */
export function variantOfAppId(id: string): VariantRow {
  const row = Object.values(VARIANTS).find((r) => r.id === id);
  if (row === undefined) throw new Error(`the app's identifier "${id}" is in no row of variants.json`);
  return row;
}

/** The app this one's switch opens. */
export function siblingOf(row: VariantRow): VariantRow {
  return VARIANTS[row.sibling];
}

/** Store ohcal launches its sibling directly while the pairing transfer stays in preview. */
export const launchOnlySwitch = (row: VariantRow): boolean => row.app === "ohcal" && row.channel === "release";

/** The phone organizes a mailbox on its own only in an app that carries the engine. */
export const standaloneOf = (row: VariantRow): boolean => row.carries.organizes;

/**
 * The app the system says this is, from the switch module's own identifier. Every app carries the module, so a build
 * without it, like an identifier outside the table, throws.
 */
export function appOfNative(appId: string | null): VariantRow {
  if (appId === null) throw new Error("this build carries no switch module, so it is no app of variants.json: make it again");
  return variantOfAppId(appId);
}

/**
 * The identifier the build's embedded configuration names must be the one the system reports: a native project made
 * for one app and a configuration resolved for the other would otherwise run as the wrong app. Absent is unjudged.
 */
export function assertEmbeddedApp(app: VariantRow, embedded: string | null | undefined): void {
  if (typeof embedded === "string" && embedded !== app.id) {
    throw new Error(`this build was configured as "${embedded}" and installed as "${app.id}": make it again for one app`);
  }
}
