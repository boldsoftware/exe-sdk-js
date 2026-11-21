// Writes src/version.ts from package.json, the version's one source.
// Run by npm run build and by npm version.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const out = `// Written from package.json by scripts/version.mjs. DO NOT EDIT.

/** This SDK's version, as in its User-Agent: exedev-js/VERSION. */
export const VERSION = ${JSON.stringify(version)};
`;
const path = new URL("../src/version.ts", import.meta.url);
let old = "";
try { old = readFileSync(path, "utf8"); } catch {}
if (old !== out) writeFileSync(path, out);
