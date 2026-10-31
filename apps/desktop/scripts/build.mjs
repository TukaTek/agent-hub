import { build } from "esbuild";
import { desktopDiscoveryDefine, desktopEditionDefine } from "./desktop-edition.mjs";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  define: { ...desktopEditionDefine(process.env), ...desktopDiscoveryDefine(process.env) },
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  external: ["electron", "electron-updater", "koffi", "@sentry/electron"],
});
