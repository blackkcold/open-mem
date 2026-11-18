#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
const { tsImport } = require("tsx/esm/api");
const cli = await tsImport(new URL("../plugin/src/migration/cli.ts", import.meta.url).href, import.meta.url);
process.exit(await cli.runMigrateCli(process.argv.slice(2)));
