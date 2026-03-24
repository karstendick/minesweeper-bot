/**
 * Runs the vision pipeline against all downloaded images and reports results.
 *
 * Usage: npx tsx scripts/test-vision.ts [--limit 10] [--verbose]
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { detectBoard, formatBoard, type CellState } from "../src/vision.js";

const IMAGES_DIR = join(import.meta.dirname, "..", "data", "images");

function parseArgs(): { limit: number; verbose: boolean } {
  const args = process.argv.slice(2);
  let limit = Infinity;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1]!, 10);
      i++;
    } else if (args[i] === "--verbose") {
      verbose = true;
    }
  }

  return { limit, verbose };
}


async function main() {
  const { limit, verbose } = parseArgs();

  const files = readdirSync(IMAGES_DIR)
    .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
    .slice(0, limit);

  console.log(`Testing vision pipeline on ${files.length} images...\n`);

  let detected = 0;
  let failed = 0;
  let errors = 0;

  const gridSizes = new Map<string, number>();
  const cellStateCounts = new Map<CellState, number>();

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const path = join(IMAGES_DIR, file);

    try {
      const result = await detectBoard(path);

      if (result) {
        detected++;
        const sizeKey = `${result.cols}x${result.rows}`;
        gridSizes.set(sizeKey, (gridSizes.get(sizeKey) ?? 0) + 1);

        for (const row of result.board) {
          for (const cell of row) {
            cellStateCounts.set(cell, (cellStateCounts.get(cell) ?? 0) + 1);
          }
        }

        if (verbose) {
          console.log(`✓ ${file}: ${result.cols}x${result.rows} grid, cell=${result.cellSize.width}x${result.cellSize.height}px`);
          console.log(formatBoard(result.board));
          console.log();
        }
      } else {
        failed++;
        if (verbose) {
          console.log(`✗ ${file}: no grid detected`);
        }
      }
    } catch (err) {
      errors++;
      if (verbose) {
        console.log(`! ${file}: error — ${err}`);
      }
    }

    if ((i + 1) % 100 === 0) {
      console.log(`  Progress: ${i + 1}/${files.length} (${detected} detected, ${failed} no grid, ${errors} errors)`);
    }
  }

  console.log("\n=== RESULTS ===");
  console.log(`Total images: ${files.length}`);
  console.log(`Grid detected: ${detected} (${((detected / files.length) * 100).toFixed(1)}%)`);
  console.log(`No grid found: ${failed} (${((failed / files.length) * 100).toFixed(1)}%)`);
  console.log(`Errors: ${errors} (${((errors / files.length) * 100).toFixed(1)}%)`);

  if (gridSizes.size > 0) {
    console.log("\n--- Grid sizes detected ---");
    for (const [size, count] of [...gridSizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${size}: ${count}`);
    }
  }

  if (cellStateCounts.size > 0) {
    console.log("\n--- Cell state distribution ---");
    const total = [...cellStateCounts.values()].reduce((a, b) => a + b, 0);
    for (const [state, count] of [...cellStateCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${state}: ${count} (${((count / total) * 100).toFixed(1)}%)`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
