import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const consoleRoot = path.resolve(here, "..");
const extensionRoot = path.resolve(consoleRoot, "..", "extension");
const pkg = JSON.parse(
  readFileSync(path.join(consoleRoot, "package.json"), "utf8"),
);
const buildTime = process.env.BUILD_TIME ?? new Date().toISOString();

const common = {
  bundle: true,
  minify: true,
  sourcemap: false,
  logLevel: "info",
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": '"production"',
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
};

const browserEntries = [
  ["src/extension/entry-page.tsx", "page/main.js"],
  ["src/extension/entry-panel.tsx", "panel/main.js"],
  ["src/extension/entry-status.ts", "status/main.js"],
];

for (const [input, output] of browserEntries) {
  await build({
    ...common,
    entryPoints: [path.join(consoleRoot, input)],
    outfile: path.join(extensionRoot, output),
    format: "iife",
    platform: "browser",
    target: ["chrome120", "safari17"],
    jsx: "automatic",
    loader: {
      ".css": "text",
    },
  });
}

await build({
  ...common,
  minify: false,
  entryPoints: [path.join(extensionRoot, "src/service/main.ts")],
  outfile: path.join(extensionRoot, "service/main.js"),
  format: "esm",
  platform: "node",
  target: "node20",
});
