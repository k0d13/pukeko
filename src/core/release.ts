declare const PUKEKO_RELEASE: string | undefined;

export const repo = "k0d13/pukeko";

/** The release tag, defined by the release build */
export const version = typeof PUKEKO_RELEASE === "string" ? PUKEKO_RELEASE : "dev";

/** False when Bun runs the source, where process.execPath is Bun itself */
export const compiled = Bun.main.startsWith("/$bunfs/");
