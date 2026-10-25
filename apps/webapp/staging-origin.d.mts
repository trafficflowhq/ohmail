/* The declarations for `staging-origin.mjs`, for the programs that compile the shared shell without
   `allowJs` (the desktop window's). */
export const STAGING_ORIGIN_VAR: "NEXT_PUBLIC_STAGING_ORIGIN";
export function stagingUploadSource(raw: string | undefined | null): string | null;
export function assertStagingOrigin(env: Record<string, string | undefined>, build: { selfhost: boolean }): string | null;
export function withStaging(csp: string, source: string | null | undefined): string;
export function stagingAdmits(url: string, source: string | null, pageOrigin: string): boolean;
