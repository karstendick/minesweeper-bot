/**
 * Extract 16x20 templates using the exact cluster-based bbox logic from vision.ts.
 * Shows the bitmap that the matcher would see for each cell.
 *
 * Usage: npx tsx scripts/extract-templates-cluster.ts <image> <col,row=digit> ...
 */

import { join } from "node:path";
import sharp from "sharp";
import { detectBoard } from "../src/vision.js";
import { extractDigitBitmap } from "../src/skins/clean-one.js";
import { TMPL_W, TMPL_H } from "../src/skins/clean-one-templates.js";

const IMAGES_DIR = join(import.meta.dirname, "..", "data", "images");
const filename = process.argv[2] ?? "1jhbi9c.jpeg";
const imagePath = filename.includes("/") ? filename : join(IMAGES_DIR, filename);
const assignments = process.argv.slice(3);

const result = await detectBoard(imagePath);
if (!result) { console.log("No grid"); process.exit(1); }

const { data, info } = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });

function getGray(x: number, y: number): number {
  const idx = (y * info.width + x) * 3;
  return (data[idx]! + data[idx + 1]! + data[idx + 2]!) / 3;
}

for (const assignment of assignments) {
  const [posStr, digit] = assignment.split("=");
  const [colStr, rowStr] = posStr!.split(",");
  const col = parseInt(colStr!);
  const row = parseInt(rowStr!);

  const cellX = result.colBorders[col]!;
  const cellY = result.rowBorders[row]!;
  const cellW = result.colBorders[col + 1]! - cellX;
  const cellH = result.rowBorders[row + 1]! - cellY;

  // Compute threshold (same as classifyCleanOneCell)
  const margin = Math.floor(Math.min(cellW, cellH) * 0.08);
  let bgSum = 0, bgCnt = 0;
  for (let dy = margin; dy < cellH - margin; dy += 5) {
    for (let dx = margin; dx < cellW - margin; dx += 5) {
      const x = cellX + dx, y = cellY + dy;
      if (x >= info.width || y >= info.height) continue;
      const g = getGray(x, y);
      if (g < 100) { bgSum += g; bgCnt++; }
    }
  }
  const thresh = (bgCnt > 0 ? bgSum / bgCnt : 51) + (220 - (bgCnt > 0 ? bgSum / bgCnt : 51)) * 0.5;

  const bitmap = extractDigitBitmap(
    { data, width: info.width, height: info.height },
    cellX, cellY, cellW, cellH, thresh,
  );

  if (!bitmap) {
    console.log(`\n"${digit}" at (${col},${row}): no digit found, skipping`);
    continue;
  }

  // Format as template code
  const bits: string[] = [];
  let fill = 0;
  for (let ty = 0; ty < TMPL_H; ty++) {
    let row16 = "";
    for (let tx = 0; tx < TMPL_W; tx++) {
      const val = bitmap[ty * TMPL_W + tx] ? "1" : "0";
      row16 += val;
      if (val === "1") fill++;
    }
    bits.push(row16);
  }

  console.log(`\n// "${digit}" from (${col},${row}) cell=${cellW}x${cellH} fill=${fill}/${TMPL_W * TMPL_H} thresh=${thresh.toFixed(0)}`);
  for (const b of bits) {
    console.log("//  " + b.replace(/0/g, " ").replace(/1/g, "█"));
  }
  console.log(`{ state: "${digit}", bitmap:`);
  for (let i = 0; i < bits.length; i++) {
    console.log(`  "${bits[i]}"${i < bits.length - 1 ? " +" : ""}`);
  }
  console.log(`},`);
}
