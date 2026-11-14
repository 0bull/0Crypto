// Writes the trail compositions, static final frames and label CSS. Run: node scripts/build-trail.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { LAYOUTS } from "./trail/geometry.ts";
import { buildTrail } from "./trail/lottie.ts";
import { buildGeometryCss, buildStaticSvg } from "./trail/svg.ts";

const ROOT = join(import.meta.dirname, "..");

function write(path: string, body: string): void {
  const file = join(ROOT, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  console.log(`trail: ${relative(ROOT, file)} (${Buffer.byteLength(body)} bytes)`);
}

for (const layout of LAYOUTS) {
  write(`public/lottie/trail-${layout}.json`, JSON.stringify(buildTrail(layout)));
  write(`src/generated/trail-${layout}.svg`, buildStaticSvg(layout));
}
write("src/generated/trail-geometry.css", buildGeometryCss());
