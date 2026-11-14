// Copies the latin woff2 subsets we use from @fontsource into public/fonts (all three families are OFL).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "fonts");
mkdirSync(out, { recursive: true });

const files = [
  ["archivo", "archivo", [800]],
  ["inter", "inter", [400, 500, 600]],
  ["jetbrains-mono", "jetbrains-mono", [400, 500]],
];
for (const [pkg, name, weights] of files)
  for (const w of weights) {
    const f = `${name}-latin-${w}-normal.woff2`;
    copyFileSync(join(root, "node_modules", "@fontsource", pkg, "files", f), join(out, f));
    console.log("copied", f);
  }
