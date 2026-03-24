/**
 * Draw detected grid lines on the image and save the result.
 * Outputs to data/debug/<filename>-grid.png
 *
 * Usage: npx tsx scripts/visualize-grid.ts <image-file>
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { detectBoard, cvReady } from "../src/vision.js";

const IMAGES_DIR = join(import.meta.dirname, "..", "data", "images");
const OUT_DIR = join(import.meta.dirname, "..", "data", "debug");
mkdirSync(OUT_DIR, { recursive: true });

const filename = process.argv[2];
if (!filename) {
  console.error("Usage: npx tsx scripts/visualize-grid.ts <image-file>");
  process.exit(1);
}

const imagePath = filename.includes("/") ? filename : join(IMAGES_DIR, filename);
const baseName = filename.replace(/.*\//, "").replace(/\.[^.]+$/, "");

await cvReady;
const result = await detectBoard(imagePath);
if (!result) {
  console.log("No grid detected.");
  process.exit(1);
}

console.log(`Grid: ${result.cols}x${result.rows} cell=${result.cellSize.width}x${result.cellSize.height}`);
console.log(`Bounds: x=${result.gridBounds.x} y=${result.gridBounds.y}`);
console.log(`Col borders: ${result.colBorders.join(", ")}`);
console.log(`Row borders: ${result.rowBorders.join(", ")}`);

// Load image and draw grid lines using SVG overlay
const meta = await sharp(imagePath).metadata();
const imgW = meta.width!;
const imgH = meta.height!;

// Build SVG with grid lines and cell labels
let svg = `<svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">`;

// Draw vertical lines (column borders)
for (const x of result.colBorders) {
  svg += `<line x1="${x}" y1="${result.rowBorders[0]}" x2="${x}" y2="${result.rowBorders[result.rows]}" stroke="lime" stroke-width="2" opacity="0.8"/>`;
}

// Draw horizontal lines (row borders)
for (const y of result.rowBorders) {
  svg += `<line x1="${result.colBorders[0]}" y1="${y}" x2="${result.colBorders[result.cols]}" y2="${y}" stroke="lime" stroke-width="2" opacity="0.8"/>`;
}

// Label each cell
const charMap: Record<string, string> = {
  hidden: ".", empty: " ", flag: "F", mine: "*", unknown: "?",
  "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "6": "6", "7": "7", "8": "8",
};

for (let row = 0; row < result.rows; row++) {
  for (let col = 0; col < result.cols; col++) {
    const state = result.board[row]![col]!;
    const label = charMap[state] ?? "?";
    const cx = (result.colBorders[col]! + result.colBorders[col + 1]!) / 2;
    const cy = (result.rowBorders[row]! + result.rowBorders[row + 1]!) / 2;
    const fontSize = Math.max(10, Math.min(24, Math.floor(result.cellSize.width * 0.3)));

    // Background circle for readability
    svg += `<circle cx="${cx}" cy="${cy}" r="${fontSize * 0.7}" fill="black" opacity="0.6"/>`;
    svg += `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="monospace" font-size="${fontSize}" fill="${label === "." ? "orange" : label === "F" ? "red" : label === " " ? "gray" : "white"}" font-weight="bold">${label === " " ? "·" : label}</text>`;
  }
}

svg += `</svg>`;

const outPath = join(OUT_DIR, `${baseName}-grid.png`);
await sharp(imagePath)
  .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .png()
  .toFile(outPath);

console.log(`\nSaved: ${outPath}`);
