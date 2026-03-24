/**
 * Manual checking tool for grid detection across any skin.
 * Shows the detected grid as a 2D character array for visual verification.
 *
 * Usage:
 *   npx tsx scripts/check-grid.ts <image-file>                — check one image
 *   npx tsx scripts/check-grid.ts --skin classic [--offset N]  — iterate through data/<skin>-images.txt
 *
 * Character legend:
 *   .  hidden    F  flag    *  mine    (space)  empty/revealed
 *   1-8  numbers    ?  unknown
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { detectBoard, cellStateToChar, type CellState } from "../src/vision.js";

const IMAGES_DIR = join(import.meta.dirname, "..", "data", "images");
const DATA_DIR = join(import.meta.dirname, "..", "data");

function renderBoard(board: CellState[][]): string {
  const lines: string[] = [];
  const cols = board[0]?.length ?? 0;
  if (cols <= 40) {
    const tens = Array.from({ length: cols }, (_, i) => (i >= 10 ? String(Math.floor(i / 10)) : " ")).join("");
    const ones = Array.from({ length: cols }, (_, i) => String(i % 10)).join("");
    lines.push("   " + tens);
    lines.push("   " + ones);
    lines.push("   " + "─".repeat(cols));
  }
  for (let r = 0; r < board.length; r++) {
    const prefix = String(r).padStart(2, " ") + "│";
    lines.push(prefix + board[r]!.map((c) => cellStateToChar[c]).join(""));
  }
  return lines.join("\n");
}

async function checkImage(filename: string): Promise<void> {
  const imagePath = filename.includes("/") ? filename : join(IMAGES_DIR, filename);
  const baseName = filename.includes("/") ? filename.split("/").pop()! : filename;

  const start = performance.now();
  const result = await detectBoard(imagePath);
  const elapsed = performance.now() - start;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Image: ${baseName}  (${elapsed.toFixed(0)}ms)`);
  console.log(`${"=".repeat(60)}`);

  if (!result) {
    console.log("  No grid detected");
    return;
  }

  console.log(`Skin: ${result.skin}  Grid: ${result.cols}x${result.rows}  Cell: ${result.cellSize.width}x${result.cellSize.height}px`);
  console.log(`Bounds: x=${result.gridBounds.x} y=${result.gridBounds.y} w=${result.gridBounds.width} h=${result.gridBounds.height}`);
  console.log();
  console.log(renderBoard(result.board));

  const counts = new Map<string, number>();
  for (const row of result.board) {
    for (const cell of row) {
      counts.set(cell, (counts.get(cell) ?? 0) + 1);
    }
  }
  const summary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, c]) => `${s}:${c}`)
    .join("  ");
  console.log(`\nCells: ${result.cols * result.rows} total — ${summary}`);
}

async function main() {
  const args = process.argv.slice(2);

  const skinIdx = args.indexOf("--skin");
  if (skinIdx >= 0) {
    const skin = args[skinIdx + 1];
    if (!skin) {
      console.error("--skin requires a value (e.g. --skin classic)");
      process.exit(1);
    }
    const listPath = join(DATA_DIR, `${skin}-images.txt`);
    if (!existsSync(listPath)) {
      console.error(`No ${listPath} found. Run: npx tsx scripts/find-by-skin.ts --save`);
      process.exit(1);
    }
    const files = readFileSync(listPath, "utf-8").trim().split("\n").filter(Boolean);
    const offsetIdx = args.indexOf("--offset");
    const offset = offsetIdx >= 0 ? parseInt(args[offsetIdx + 1]!, 10) : 0;

    console.log(`${skin} images: ${files.length} total, starting at offset ${offset}`);
    for (let i = offset; i < files.length; i++) {
      await checkImage(files[i]!);
    }
  } else if (args.length > 0 && !args[0]!.startsWith("--")) {
    await checkImage(args[0]!);
  } else {
    console.error("Usage:");
    console.error("  npx tsx scripts/check-grid.ts <image-file>");
    console.error("  npx tsx scripts/check-grid.ts --skin classic [--offset N]");
    process.exit(1);
  }
}

main();
