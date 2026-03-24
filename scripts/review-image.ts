/**
 * Review a single image: run grid detection, generate visualization, open both images,
 * and print the detected grid to the terminal.
 *
 * Usage: npx tsx scripts/review-image.ts <image-file>
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import sharp from "sharp";
import { detectBoard, cellStateToChar, type CellState } from "../src/vision.js";

const IMAGES_DIR = join(import.meta.dirname, "..", "data", "images");
const DEBUG_DIR = join(import.meta.dirname, "..", "data", "debug");
mkdirSync(DEBUG_DIR, { recursive: true });

const filename = process.argv[2];
if (!filename) {
  console.error("Usage: npx tsx scripts/review-image.ts <image-file>");
  process.exit(1);
}

const imagePath = filename.includes("/") ? filename : join(IMAGES_DIR, filename);
const baseName = filename.replace(/.*\//, "").replace(/\.[^.]+$/, "");

// Detect
const result = await detectBoard(imagePath);

if (!result) {
  console.log("No grid detected.");
  execSync(`open "${imagePath}"`);
  process.exit(1);
}

// Print grid
console.log(`Grid: ${result.cols}x${result.rows}  Cell: ${result.cellSize.width}x${result.cellSize.height}px  Skin: ${result.skin}\n`);

const cols = result.board[0]?.length ?? 0;
if (cols <= 40) {
  const tens = Array.from({ length: cols }, (_, i) => (i >= 10 ? String(Math.floor(i / 10)) : " ")).join("");
  const ones = Array.from({ length: cols }, (_, i) => String(i % 10)).join("");
  console.log("   " + tens);
  console.log("   " + ones);
  console.log("   " + "─".repeat(cols));
}
for (let r = 0; r < result.rows; r++) {
  const prefix = String(r).padStart(2, " ") + "│";
  console.log(prefix + result.board[r]!.map((c) => cellStateToChar[c]).join(""));
}

// Cell counts
const counts = new Map<string, number>();
for (const row of result.board) {
  for (const cell of row) {
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
}
console.log("\n" + [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s}:${c}`).join("  "));

// Generate visualization
const meta = await sharp(imagePath).metadata();
const imgW = meta.width!;
const imgH = meta.height!;

let svg = `<svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">`;
for (const x of result.colBorders) {
  svg += `<line x1="${x}" y1="${result.rowBorders[0]}" x2="${x}" y2="${result.rowBorders[result.rows]}" stroke="lime" stroke-width="2" opacity="0.8"/>`;
}
for (const y of result.rowBorders) {
  svg += `<line x1="${result.colBorders[0]}" y1="${y}" x2="${result.colBorders[result.cols]}" y2="${y}" stroke="lime" stroke-width="2" opacity="0.8"/>`;
}
for (let row = 0; row < result.rows; row++) {
  for (let col = 0; col < result.cols; col++) {
    const state = result.board[row]![col]!;
    const label = cellStateToChar[state] ?? "?";
    const cx = (result.colBorders[col]! + result.colBorders[col + 1]!) / 2;
    const cy = (result.rowBorders[row]! + result.rowBorders[row + 1]!) / 2;
    const fontSize = Math.max(10, Math.min(24, Math.floor(result.cellSize.width * 0.3)));
    svg += `<circle cx="${cx}" cy="${cy}" r="${fontSize * 0.7}" fill="black" opacity="0.6"/>`;
    svg += `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="monospace" font-size="${fontSize}" fill="${label === "." ? "orange" : label === "F" ? "red" : label === " " ? "gray" : "white"}" font-weight="bold">${label === " " ? "·" : label}</text>`;
  }
}
svg += `</svg>`;

const gridPath = join(DEBUG_DIR, `${baseName}-grid.png`);
await sharp(imagePath)
  .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .png()
  .toFile(gridPath);

// Open in separate windows
execSync(`open "${imagePath}"`);
execSync(`open "${gridPath}"`);
