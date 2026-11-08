// Bundle the engine into self-contained ESM files. Native/heavy modules stay external and
// are resolved from node_modules at runtime.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["better-sqlite3", "sharp", "@e04/ft8ts", "ws", "nodemailer"],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
};

await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/engine.mjs" });
await build({ ...common, entryPoints: ["src/digital/decode-worker.ts"], outfile: "dist/decode-worker.mjs" });
await build({ ...common, entryPoints: ["src/digital/aux-worker.ts"], outfile: "dist/aux-worker.mjs" });
