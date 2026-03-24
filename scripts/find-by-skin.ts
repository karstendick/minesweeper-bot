/**
 * Classify all images by detected skin type and save per-skin lists.
 *
 * Usage:
 *   npx tsx scripts/find-by-skin.ts              — show counts per skin
 *   npx tsx scripts/find-by-skin.ts --save        — also write data/<skin>-images.txt files
 *   npx tsx scripts/find-by-skin.ts --skin classic — only list images matching a specific skin
 */

import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifySkin, type Skin } from "../src/vision.js";

const IMAGES_DIR = join(import.meta.dirname, "..", "data", "images");
const DATA_DIR = join(import.meta.dirname, "..", "data");

async function main() {
  const args = process.argv.slice(2);
  const save = args.includes("--save");
  const skinIdx = args.indexOf("--skin");
  const filterSkin = skinIdx >= 0 ? args[skinIdx + 1] : null;

  const files = readdirSync(IMAGES_DIR).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
  console.error(`Scanning ${files.length} images...`);

  const bySkin = new Map<string, string[]>();

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    try {
      const skin = await classifySkin(join(IMAGES_DIR, file));
      if (!bySkin.has(skin)) bySkin.set(skin, []);
      bySkin.get(skin)!.push(file);
    } catch {
      // skip bad images
    }

    if ((i + 1) % 500 === 0) {
      const counts = [...bySkin.entries()].map(([s, f]) => `${s}:${f.length}`).join(" ");
      console.error(`  ${i + 1}/${files.length} — ${counts}`);
    }
  }

  // Summary
  console.error(`\n=== Results ===`);
  for (const [skin, skinFiles] of [...bySkin.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.error(`  ${skin}: ${skinFiles.length}`);
  }

  // Filter output
  if (filterSkin) {
    const skinFiles = bySkin.get(filterSkin) ?? [];
    for (const f of skinFiles) console.log(f);
  }

  // Save per-skin lists
  if (save) {
    for (const [skin, skinFiles] of bySkin.entries()) {
      if (skin === "unknown") continue;
      const outPath = join(DATA_DIR, `${skin}-images.txt`);
      writeFileSync(outPath, skinFiles.join("\n") + "\n");
      console.error(`Saved ${outPath} (${skinFiles.length} images)`);
    }
  }
}

main();
