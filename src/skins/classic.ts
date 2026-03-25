/**
 * Classic Windows Minesweeper / minesweeper.online skin.
 *
 * Characteristic pixel values:
 *   ~198 = revealed cell interior
 *   ~128 = cell border (shadow side of bevel)
 *   ~255 = cell bevel highlight
 *   ~165 = anti-aliased transition between 128 and 198
 * JPEG compression shifts these values by ±5, so we use tolerant matching.
 */

import { getPixel } from "../image-utils.js";
import { extractDigitBitmap, matchDigit } from "../template-matching.js";
import type { CellState, ImageData } from "../types.js";
import { CLASSIC_TEMPLATES } from "./classic-templates.js";

// --- Color predicates ---

const BORDER_TOL = 4;
const WHITE_TOL = 8;

function isBorderGray(r: number, g: number, b: number, tol: number = BORDER_TOL): boolean {
  return Math.abs(r - 128) <= tol &&
         Math.abs(g - 128) <= tol &&
         Math.abs(b - 128) <= tol &&
         Math.max(r, g, b) - Math.min(r, g, b) <= Math.max(6, tol);
}


function isWhite(r: number, g: number, b: number): boolean {
  return r >= 255 - WHITE_TOL && g >= 255 - WHITE_TOL && b >= 255 - WHITE_TOL;
}

// --- Grid detection ---

export function detectClassicGrid(img: ImageData): {
  colBorders: number[]; rowBorders: number[]; cellSize: number; rows: number; cols: number;
} | null {
  // Try with strict tolerance first, then retry with wider tolerance
  // for images with slightly shifted border colors.
  return detectClassicGridWithTol(img, BORDER_TOL)
      ?? detectClassicGridWithTol(img, BORDER_TOL * 2);
}

function detectClassicGridWithTol(img: ImageData, borderTol: number): {
  colBorders: number[]; rowBorders: number[]; cellSize: number; rows: number; cols: number;
} | null {
  const { width, height } = img;

  // Scan multiple horizontal rows for 128-gray border pixels and merge results.
  // A single row can miss borders where number text interrupts the border pixel.
  // Skip scan rows that land on horizontal border lines (where most pixels are
  // border-gray), as these contaminate vertical border detection.
  const hBorderSet = new Set<number>();
  const scanYs = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((f) => Math.floor(height * f));

  for (const scanY of scanYs) {
    const rowBorders: number[] = [];
    for (let x = 0; x < width; x++) {
      const [r, g, b] = getPixel(img, x, scanY);
      if (isBorderGray(r, g, b, borderTol)) rowBorders.push(x);
    }
    // If > 40% of the width is border-gray, this scan row is on a horizontal
    // border line — skip it to avoid flooding vertical border detection.
    if (rowBorders.length > width * 0.4) continue;
    for (const x of rowBorders) hBorderSet.add(x);
  }

  // Cluster consecutive border pixels (borders can be 1-3px wide).
  // Use the center of each cluster for more stable positioning.
  const borderLines: number[] = [];
  const sortedHBorders = [...hBorderSet].sort((a, b) => a - b);
  let clusterStartPos = -10;
  let clusterSum = 0, clusterCount = 0;
  for (const pos of sortedHBorders) {
    if (pos - clusterStartPos > 3) {
      if (clusterCount > 0) borderLines.push(Math.round(clusterSum / clusterCount));
      clusterSum = pos; clusterCount = 1;
    } else {
      clusterSum += pos; clusterCount++;
    }
    clusterStartPos = pos;
  }
  if (clusterCount > 0) borderLines.push(Math.round(clusterSum / clusterCount));

  if (borderLines.length < 4) return null;

  // Find the dominant spacing = cell size
  const spacings = new Map<number, number>();
  for (let i = 1; i < borderLines.length; i++) {
    const s = borderLines[i]! - borderLines[i - 1]!;
    if (s >= 10 && s <= 150) {
      spacings.set(s, (spacings.get(s) ?? 0) + 1);
    }
  }

  if (spacings.size === 0) return null;

  let cellSize = 0;
  let bestCount = 0;
  for (const [s, count] of spacings) {
    const total = count + (spacings.get(s - 1) ?? 0) + (spacings.get(s + 1) ?? 0);
    if (total > bestCount) {
      bestCount = total;
      cellSize = s;
    }
  }

  if (cellSize < 10 || bestCount < 5) return null;

  // Find columns using dominant spacing with skip tolerance
  const gridCols = findGridLines(borderLines, cellSize, 3);
  if (gridCols.length < 4) return null;

  // Scan vertically across multiple cell-interior x-positions to find rows
  const vBorderSet = new Set<number>();
  for (let colIdx = 0; colIdx < gridCols.length - 1; colIdx += Math.max(1, Math.floor(gridCols.length / 6))) {
    const scanX = Math.floor((gridCols[colIdx]! + gridCols[colIdx + 1]!) / 2);
    for (let y = 0; y < height; y++) {
      const [r, g, b] = getPixel(img, scanX, y);
      if (isBorderGray(r, g, b, borderTol)) {
        vBorderSet.add(y);
      }
    }
  }

  const vBorderLines: number[] = [];
  const sortedVBorders = [...vBorderSet].sort((a, b) => a - b);
  let vClusterStart = -10;
  for (const pos of sortedVBorders) {
    if (pos - vClusterStart > 3) {
      vBorderLines.push(pos);
    }
    vClusterStart = pos;
  }

  const gridRows = findGridLines(vBorderLines, cellSize);
  if (gridRows.length < 4) return null;

  // Extend grid to include cells before/after detected borders
  const firstColX = gridCols[0]!;
  const firstRowY = gridRows[0]!;

  const cellBeforeCol = firstColX - cellSize;
  if (cellBeforeCol >= 0 && hasBoardContent(img, cellBeforeCol, firstRowY, cellSize)) {
    gridCols.unshift(cellBeforeCol);
  }

  // Try to extend the grid one row upward. Search a small range around the
  // expected position for a border pixel (grids can be offset by a few pixels).
  // If no border pixel is found, still add the row if there's clear board content.
  const cellBeforeRow = firstRowY - cellSize;
  if (cellBeforeRow >= 0) {
    const midX = gridCols[Math.floor(gridCols.length / 2)]!;
    let added = false;
    for (let yOff = -5; yOff <= 5; yOff++) {
      const testY = cellBeforeRow + yOff;
      if (testY < 0) continue;
      const [r, g, b] = getPixel(img, midX, testY);
      if (isBorderGray(r, g, b, borderTol) && hasBoardContent(img, firstColX, testY, cellSize)) {
        gridRows.unshift(testY);
        added = true;
        break;
      }
    }
    // Fallback: add based on board content alone (e.g., header-to-board boundary
    // doesn't use standard border gray)
    if (!added && cellBeforeRow >= 0 && hasBoardContent(img, firstColX, cellBeforeRow, cellSize)) {
      gridRows.unshift(cellBeforeRow);
    }
  }

  // Find frame borders: solid 128-gray OR very dark (< 40) columns/rows.
  // Classic minesweeper frames can be either gray border or dark background.
  function isFramePixel(r: number, g: number, b: number): boolean {
    // Border gray, dark background, or light window frame (220-250 neutral gray)
    if (isBorderGray(r, g, b, borderTol)) return true;
    if (r < 40 && g < 40 && b < 40) return true;
    const brightness = (r + g + b) / 3;
    if (brightness >= 220 && brightness <= 250 &&
        Math.max(r, g, b) - Math.min(r, g, b) <= 10) return true;
    return false;
  }

  // Search from the midpoint of the last detected cell — the frame may start
  // within the last cell if the grid extension overshot.
  let rightFrame = width;
  const rightSearchStart = gridCols[gridCols.length - 1]! + Math.floor(cellSize / 2);
  for (let x = rightSearchStart; x < width; x++) {
    let frameCount = 0;
    for (let y = gridRows[0]!; y < gridRows[gridRows.length - 1]!; y += 10) {
      const [r, g, b] = getPixel(img, x, y);
      if (isFramePixel(r, g, b)) frameCount++;
    }
    const totalSamples = Math.floor((gridRows[gridRows.length - 1]! - gridRows[0]!) / 10);
    if (frameCount > totalSamples * 0.8) {
      rightFrame = x;
      break;
    }
  }

  // Search for bottom frame. Start from a few cells before the last detected
  // border — findGridLines may have extended into the frame area. Require
  // 3+ consecutive frame rows to distinguish thick frame borders from thin
  // cell borders (1-2px of 128 gray).
  let bottomFrame = height;
  // For large grids (>15 rows), search for the frame earlier since
  // findGridLines may have extended far into the window frame area.
  const bottomSearchFrom = gridRows.length > 18
    ? gridRows[gridRows.length - 5]! + Math.floor(cellSize / 2)
    : gridRows[gridRows.length - 1]! + Math.floor(cellSize / 2);
  let consecutiveFrameRows = 0;
  for (let y = bottomSearchFrom; y < height; y++) {
    let frameCount = 0;
    for (let x = gridCols[0]!; x < gridCols[gridCols.length - 1]!; x += 10) {
      const [r, g, b] = getPixel(img, x, y);
      if (isFramePixel(r, g, b)) frameCount++;
    }
    const totalSamples = Math.floor((gridCols[gridCols.length - 1]! - gridCols[0]!) / 10);
    if (frameCount > totalSamples * 0.8) {
      consecutiveFrameRows++;
      if (consecutiveFrameRows >= 3) {
        bottomFrame = y - 2; // start of the frame block
        break;
      }
    } else {
      consecutiveFrameRows = 0;
    }
  }

  // Trim grid borders whose cells would extend into or past the frame.
  // Also remove borders that fall within the frame itself.
  while (gridCols.length > 2 && gridCols[gridCols.length - 1]! + cellSize > rightFrame + cellSize / 2) {
    gridCols.pop();
  }
  while (gridRows.length > 2 && gridRows[gridRows.length - 1]! + cellSize > bottomFrame + cellSize / 2) {
    gridRows.pop();
  }

  // Extend columns/rows up to frame borders
  const midRow = gridRows[Math.floor(gridRows.length / 2)]!;
  while (true) {
    const lastX = gridCols[gridCols.length - 1]!;
    if (lastX + cellSize > rightFrame + 2) break;
    if (!hasBoardContent(img, lastX, midRow, cellSize)) break;
    gridCols.push(lastX + cellSize);
  }

  const midCol = gridCols[Math.floor(gridCols.length / 2)]!;
  while (true) {
    const lastY = gridRows[gridRows.length - 1]!;
    if (lastY + cellSize > bottomFrame + 2) break;
    if (!hasBoardContent(img, midCol, lastY, cellSize)) break;
    gridRows.push(lastY + cellSize);
  }

  const cols = gridCols.length - 1;
  const rows = gridRows.length - 1;

  if (rows < 3 || cols < 3 || rows > 50 || cols > 50) return null;

  return {
    colBorders: gridCols.slice(0, cols + 1),
    rowBorders: gridRows.slice(0, rows + 1),
    cellSize,
    rows,
    cols,
  };
}

function findGridLines(positions: number[], cellSize: number, maxSkip: number = 2): number[] {
  let bestGrid: number[] = [];

  for (let startIdx = 0; startIdx < positions.length; startIdx++) {
    const grid: number[] = [positions[startIdx]!];
    let lastPos = positions[startIdx]!;

    while (true) {
      let found = false;
      for (let skip = 0; skip <= maxSkip; skip++) {
        const expected = lastPos + cellSize * (skip + 1);
        const match = positions.find((p) => Math.abs(p - expected) <= 2);
        if (match !== undefined) {
          for (let s = 1; s <= skip; s++) {
            grid.push(lastPos + cellSize * s);
          }
          grid.push(match);
          lastPos = match;
          found = true;
          break;
        }
      }
      if (!found) break;
    }

    if (grid.length > bestGrid.length) {
      bestGrid = grid;
    }
  }

  return bestGrid;
}

function hasBoardContent(img: ImageData, cellX: number, cellY: number, cellSize: number): boolean {
  const inset = Math.floor(cellSize * 0.25);
  let countFace = 0;
  let countColor = 0;
  let countWhite = 0;
  let total = 0;

  for (let dy = inset; dy < cellSize - inset; dy++) {
    for (let dx = inset; dx < cellSize - inset; dx++) {
      const x = cellX + dx;
      const y = cellY + dy;
      if (x < 0 || x >= img.width || y < 0 || y >= img.height) return false;
      const [r, g, b] = getPixel(img, x, y);
      total++;
      // Use wider tolerance for face gray — some images have slightly shifted
      // gray levels (e.g., 189 instead of 198).
      const brightness = (r + g + b) / 3;
      if (brightness >= 180 && brightness <= 210 &&
          Math.max(r, g, b) - Math.min(r, g, b) <= 12) countFace++;
      if (isWhite(r, g, b)) countWhite++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 20) countColor++;
    }
  }

  if (total === 0) return false;
  // Real board cells have face gray interiors. Cells that are only white
  // (bevel) or only border gray (frame shadow) aren't real board content.
  if (countFace === 0 && countColor === 0) return false;
  return (countFace + countColor + countWhite) / total > 0.3;
}

// --- Cell classification ---

// Classic glyph threshold: digits are dark/colored on ~198 gray background.
// Anything with brightness < 150 is a digit pixel.
const CLASSIC_GLYPH_THRESHOLD = 150;

// Known number colors for fallback color matching at small cell sizes.
const CLASSIC_COLORS: { state: CellState; r: number; g: number; b: number }[] = [
  { state: "1", r: 0, g: 0, b: 247 },
  { state: "2", r: 0, g: 119, b: 0 },
  { state: "3", r: 236, g: 0, b: 0 },
  { state: "4", r: 0, g: 0, b: 119 },
  { state: "5", r: 119, g: 0, b: 0 },
  { state: "6", r: 0, g: 119, b: 119 },
  { state: "7", r: 0, g: 0, b: 0 },
  { state: "8", r: 119, g: 119, b: 119 },
];

export function classifyClassicCell(
  img: ImageData,
  cellX: number,
  cellY: number,
  cellSize: number
): CellState {
  if (cellSize <= 6) return "unknown";

  // Hidden/flag detection: scan for bright bevel strip at the top of the cell.
  // Normally scan from dy=2 to skip the border row. But for cells where the
  // bevel starts at dy=0 (e.g., cells added by grid extension at image edges),
  // also include dy=1 if dy=0 is also bright.
  function isBevelBright(r: number, g: number, b: number): boolean {
    return isWhite(r, g, b) || (Math.max(r, g, b) >= 240 && Math.min(r, g, b) >= 180);
  }

  let maxBrightInRow = 0;
  const bevelEnd = Math.min(Math.floor(cellSize * 0.30), cellSize);
  // Start at dy=2 to skip border-gray rows. For cells at image edges
  // (added by grid extension), the bevel may start at dy=0-1 since there's
  // no border above/left. Use dy=1 for edge cells.
  const atBottomEdge = cellY + cellSize >= img.height - 2;
  const atTopEdge = cellY <= 2;
  const bevelStart = (atBottomEdge || atTopEdge) ? 1 : 2;
  for (let dy = bevelStart; dy < bevelEnd; dy++) {
    let brights = 0;
    const y = cellY + dy;
    if (y >= img.height) continue;
    for (let dx = 2; dx < cellSize - 2; dx++) {
      const x = cellX + dx;
      if (x >= img.width) continue;
      const [r, g, b] = getPixel(img, x, y);
      if (isBevelBright(r, g, b)) brights++;
    }
    if (brights > maxBrightInRow) maxBrightInRow = brights;
  }

  const isHiddenBevel = maxBrightInRow > cellSize / 3;

  if (isHiddenBevel) {
    let redPixels = 0;
    const inset = 3;
    for (let dy = inset; dy < cellSize - inset; dy++) {
      for (let dx = inset; dx < cellSize - inset; dx++) {
        const x = cellX + dx;
        const y = cellY + dy;
        if (x >= img.width || y >= img.height) continue;
        const [r, g, b] = getPixel(img, x, y);
        if (r > 150 && g < 100 && b < 100) redPixels++;
      }
    }
    if (redPixels > 5) return "flag";
    return "hidden";
  }

  // Scan interior for colored/dark pixels. Use small inset (3px) for color
  // collection since the colorfulness filter already excludes gray border pixels.
  const colorInset = 3;
  const coloredPixels: [number, number, number][] = [];
  let totalPixels = 0;

  for (let dy = colorInset; dy < cellSize - colorInset; dy++) {
    for (let dx = colorInset; dx < cellSize - colorInset; dx++) {
      const x = cellX + dx, y = cellY + dy;
      if (x >= img.width || y >= img.height) continue;
      totalPixels++;
      const [r, g, b] = getPixel(img, x, y);
      const colorfulness = Math.max(r, g, b) - Math.min(r, g, b);
      const brightness = (r + g + b) / 3;
      if ((colorfulness > 20 || brightness < 50) && !(r >= 190 && g >= 190 && b >= 190)) {
        coloredPixels.push([r, g, b]);
      }
    }
  }

  // Empty cell: very few colored/dark pixels in interior
  if (totalPixels === 0 || coloredPixels.length / totalPixels < 0.05) return "empty";

  // Try template matching first (works well for cells >= ~50px)
  const bitmap = extractDigitBitmap(
    img, cellX, cellY, cellSize, cellSize,
    CLASSIC_GLYPH_THRESHOLD,
    true, // invertGlyph: dark pixels = foreground
    0.20, // larger margin to skip border area
  );

  // Compute color average from most saturated pixels (resists JPEG dilution)
  let avgR = 0, avgG = 0, avgB = 0;
  if (coloredPixels.length > 0) {
    const sorted = coloredPixels
      .map(([r, g, b]) => ({ r, g, b, sat: Math.max(r, g, b) - Math.min(r, g, b) }))
      .sort((a, b) => b.sat - a.sat);
    const topN = Math.max(3, Math.floor(sorted.length / 2));
    const top = sorted.slice(0, topN);
    for (const p of top) { avgR += p.r; avgG += p.g; avgB += p.b; }
    avgR /= top.length; avgG /= top.length; avgB /= top.length;
  }

  if (bitmap) {
    // Use higher threshold for small cells where bitmaps are noisy
    const minScore = cellSize >= 50 ? 0.25 : 0.40;
    const tmplResult = matchDigit(bitmap, CLASSIC_TEMPLATES, minScore);
    if (tmplResult !== "unknown") {
      // Validate template result against pixel colors: the expected color
      // for the matched digit should be closer than any other digit's color.
      // This prevents e.g. a "2" template matching a teal "6" cell.
      const expectedSig = CLASSIC_COLORS.find((c) => c.state === tmplResult);
      if (expectedSig) {
        const tmplDist = Math.sqrt(
          (avgR - expectedSig.r) ** 2 + (avgG - expectedSig.g) ** 2 + (avgB - expectedSig.b) ** 2
        );
        let colorBest: CellState = "unknown";
        let colorBestDist = Infinity;
        for (const sig of CLASSIC_COLORS) {
          const d = Math.sqrt(
            (avgR - sig.r) ** 2 + (avgG - sig.g) ** 2 + (avgB - sig.b) ** 2
          );
          if (d < colorBestDist) { colorBestDist = d; colorBest = sig.state; }
        }
        // If color agrees with template, or template color is close enough, use template
        if (colorBest === tmplResult || tmplDist < colorBestDist * 1.5) {
          return tmplResult;
        }
        // Otherwise color disagrees — fall through to color matching
      } else {
        return tmplResult;
      }
    }
  }

  // Color matching
  if (coloredPixels.length === 0) return "empty";

  let bestMatch: CellState = "unknown";
  let bestScore = 0;
  for (const sig of CLASSIC_COLORS) {
    const dist = Math.sqrt(
      (avgR - sig.r) ** 2 + (avgG - sig.g) ** 2 + (avgB - sig.b) ** 2
    );
    const score = 1 / (1 + dist);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = sig.state;
    }
  }

  return bestMatch;
}
