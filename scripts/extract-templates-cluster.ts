/**
 * Extract 16x20 templates using the exact cluster-based bbox logic from vision.ts.
 * Shows the bitmap that the matcher would see for each cell.
 *
 * Usage: npx tsx scripts/extract-templates-cluster.ts <image> <col,row=digit> ...
 */

import { join } from "node:path";
import sharp from "sharp";
import { detectBoard, cvReady } from "../src/vision.js";

const IMAGES_DIR = join(import.meta.dirname, "..", "data", "images");
const filename = process.argv[2] ?? "1jhbi9c.jpeg";
const imagePath = filename.includes("/") ? filename : join(IMAGES_DIR, filename);
const assignments = process.argv.slice(3);

await cvReady;
const result = await detectBoard(imagePath);
if (!result) { console.log("No grid"); process.exit(1); }

const { data, info } = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });

function getGray(x: number, y: number): number {
  const idx = (y * info.width + x) * 3;
  return (data[idx]! + data[idx + 1]! + data[idx + 2]!) / 3;
}

const TMPL_W = 16, TMPL_H = 20;

for (const assignment of assignments) {
  const [posStr, digit] = assignment.split("=");
  const [colStr, rowStr] = posStr!.split(",");
  const col = parseInt(colStr!);
  const row = parseInt(rowStr!);

  const cellX = result.colBorders[col]!;
  const cellY = result.rowBorders[row]!;
  const cellW = result.colBorders[col + 1]! - cellX;
  const cellH = result.rowBorders[row + 1]! - cellY;
  const margin = Math.floor(Math.min(cellW, cellH) * 0.08);

  // Threshold
  let bgSum = 0, bgCnt = 0;
  for (let dy = margin; dy < cellH - margin; dy += 5) {
    for (let dx = margin; dx < cellW - margin; dx += 5) {
      const x = cellX + dx, y = cellY + dy;
      if (x >= info.width || y >= info.height) continue;
      const g = getGray(x, y);
      if (g < 100) { bgSum += g; bgCnt++; }
    }
  }
  const bgLvl = bgCnt > 0 ? bgSum / bgCnt : 51;
  const thresh = bgLvl + (220 - bgLvl) * 0.5;

  // Collect bright pixels
  const brightPts: { x: number; y: number }[] = [];
  for (let dy = margin; dy < cellH - margin; dy += 2) {
    for (let dx = margin; dx < cellW - margin; dx += 2) {
      const x = cellX + dx, y = cellY + dy;
      if (x >= info.width || y >= info.height) continue;
      if (getGray(x, y) > thresh) brightPts.push({ x: dx, y: dy });
    }
  }

  if (brightPts.length < 3) {
    console.log(`\n"${digit}" at (${col},${row}): only ${brightPts.length} bright pts, skipping`);
    continue;
  }

  // Cluster: median → iterative centroid
  const maxRadius = Math.floor(Math.min(cellW, cellH) * 0.25);
  let cx = brightPts.map(p => p.x).sort((a, b) => a - b)[Math.floor(brightPts.length / 2)]!;
  let cy = brightPts.map(p => p.y).sort((a, b) => a - b)[Math.floor(brightPts.length / 2)]!;

  for (let iter = 0; iter < 3; iter++) {
    const nearby = brightPts.filter(p => Math.abs(p.x - cx) < maxRadius && Math.abs(p.y - cy) < maxRadius);
    if (nearby.length === 0) break;
    cx = Math.round(nearby.reduce((s, p) => s + p.x, 0) / nearby.length);
    cy = Math.round(nearby.reduce((s, p) => s + p.y, 0) / nearby.length);
  }

  const cluster = brightPts.filter(p => Math.abs(p.x - cx) < maxRadius && Math.abs(p.y - cy) < maxRadius);
  if (cluster.length < 3) {
    console.log(`\n"${digit}" at (${col},${row}): cluster too small (${cluster.length})`);
    continue;
  }

  let gMinX = cellW, gMaxX = 0, gMinY = cellH, gMaxY = 0;
  for (const p of cluster) {
    if (p.x < gMinX) gMinX = p.x;
    if (p.x > gMaxX) gMaxX = p.x;
    if (p.y < gMinY) gMinY = p.y;
    if (p.y > gMaxY) gMaxY = p.y;
  }

  const pad = Math.max(2, Math.floor(Math.min(cellW, cellH) * 0.02));
  gMinX = Math.max(margin, gMinX - pad);
  gMaxX = Math.min(cellW - margin - 1, gMaxX + pad);
  gMinY = Math.max(margin, gMinY - pad);
  gMaxY = Math.min(cellH - margin - 1, gMaxY + pad);
  let gW = gMaxX - gMinX + 1;
  let gH = gMaxY - gMinY + 1;

  // Pad bbox to match template aspect ratio (TMPL_W:TMPL_H = 16:20 = 0.8)
  const targetRatio = TMPL_W / TMPL_H;
  const bboxRatio = gW / gH;
  if (bboxRatio < targetRatio) {
    const newW = Math.round(gH * targetRatio);
    const expand = newW - gW;
    gMinX = Math.max(margin, gMinX - Math.floor(expand / 2));
    gMaxX = Math.min(cellW - margin - 1, gMinX + newW - 1);
    gW = gMaxX - gMinX + 1;
  } else if (bboxRatio > targetRatio) {
    const newH = Math.round(gW / targetRatio);
    const expand = newH - gH;
    gMinY = Math.max(margin, gMinY - Math.floor(expand / 2));
    gMaxY = Math.min(cellH - margin - 1, gMinY + newH - 1);
    gH = gMaxY - gMinY + 1;
  }

  console.log(`\n// "${digit}" from (${col},${row}) cell=${cellW}x${cellH} bbox=${gW}x${gH} cluster=${cluster.length} thresh=${thresh.toFixed(0)}`);

  const bits: string[] = [];
  let fill = 0;
  for (let ty = 0; ty < TMPL_H; ty++) {
    let row16 = "";
    for (let tx = 0; tx < TMPL_W; tx++) {
      const x0 = cellX + gMinX + Math.floor(tx * gW / TMPL_W);
      const x1 = cellX + gMinX + Math.floor((tx + 1) * gW / TMPL_W);
      const y0 = cellY + gMinY + Math.floor(ty * gH / TMPL_H);
      const y1 = cellY + gMinY + Math.floor((ty + 1) * gH / TMPL_H);
      let sum = 0, count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (x >= 0 && x < info.width && y >= 0 && y < info.height) {
            sum += getGray(x, y);
            count++;
          }
        }
      }
      const val = (count > 0 && sum / count > thresh) ? "1" : "0";
      row16 += val;
      if (val === "1") fill++;
    }
    bits.push(row16);
  }

  for (const b of bits) {
    console.log("//  " + b.replace(/0/g, " ").replace(/1/g, "█"));
  }
  console.log(`{ state: "${digit}", bitmap:`);
  for (let i = 0; i < bits.length; i++) {
    console.log(`  "${bits[i]}"${i < bits.length - 1 ? " +" : ""}`);
  }
  console.log(`},`);
}
