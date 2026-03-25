/**
 * Extract 16x20 templates for classic skin digits using shape-based (inverted) extraction.
 *
 * Usage: npx tsx scripts/extract-classic-templates.ts <image> <col,row=digit> ...
 * Example: npx tsx scripts/extract-classic-templates.ts 1jeotcf.png 0,0=1 1,0=2
 *
 * The classic skin has dark/colored digits on a light gray (~198) background.
 * We use invertGlyph=true so dark pixels become the foreground in the bitmap.
 */

import { join } from "node:path";
import { loadImageRaw } from "../src/image-utils.js";
import { detectClassicGrid } from "../src/skins/classic.js";
import { extractDigitBitmap, TMPL_W, TMPL_H } from "../src/template-matching.js";

const IMAGES_DIR = join(import.meta.dirname, "..", "data", "images");
const filename = process.argv[2] ?? "1jeotcf.png";
const imagePath = filename.includes("/") ? filename : join(IMAGES_DIR, filename);
const assignments = process.argv.slice(3);

const img = await loadImageRaw(imagePath);
const grid = detectClassicGrid(img);
if (!grid) { console.log("No grid detected"); process.exit(1); }

console.log(`Grid: ${grid.cols}x${grid.rows} cellSize=${grid.cellSize}`);

// Classic glyph threshold: digits are dark on ~198 gray background.
// Anything with brightness < 150 is likely a digit pixel.
const CLASSIC_GLYPH_THRESHOLD = 150;

for (const assignment of assignments) {
  const [posStr, digit] = assignment.split("=");
  const [colStr, rowStr] = posStr!.split(",");
  const col = parseInt(colStr!);
  const row = parseInt(rowStr!);

  const cellX = grid.colBorders[col]!;
  const cellY = grid.rowBorders[row]!;
  const cellW = grid.colBorders[col + 1]! - cellX;
  const cellH = grid.rowBorders[row + 1]! - cellY;

  const bitmap = extractDigitBitmap(
    img, cellX, cellY, cellW, cellH,
    CLASSIC_GLYPH_THRESHOLD,
    true, // invertGlyph: dark pixels = foreground
    0.20, // match the margin used in classifyClassicCell
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

  console.log(`\n// "${digit}" from (${col},${row}) cell=${cellW}x${cellH} fill=${fill}/${TMPL_W * TMPL_H} thresh=${CLASSIC_GLYPH_THRESHOLD}`);
  for (const b of bits) {
    console.log("//  " + b.replace(/0/g, " ").replace(/1/g, "█"));
  }
  console.log(`{ state: "${digit}", bitmap:`);
  for (let i = 0; i < bits.length; i++) {
    console.log(`  "${bits[i]}"${i < bits.length - 1 ? " +" : ""}`);
  }
  console.log(`},`);
}
