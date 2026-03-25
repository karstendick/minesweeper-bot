/**
 * Vision pipeline: screenshot → 2D board state array.
 *
 * Architecture: skin detection first, then skin-specific pipeline.
 * Currently supports: Classic Windows Minesweeper, Minesweeper - The Clean One
 */

import { loadImageRaw, getPixel } from "./image-utils.js";
import { detectClassicGrid, classifyClassicCell } from "./skins/classic.js";
import { isCleanOneOrange, isCleanOneDark, detectCleanOneGrid, classifyCleanOneCell } from "./skins/clean-one.js";
import type { CellState, BoardDetectionResult, ImageData } from "./types.js";

export type { CellState, BoardDetectionResult } from "./types.js";
export { cellStateToChar, charToCellState, formatBoard } from "./types.js";

// --- Skin detection ---

type Skin = "classic" | "clean-one" | "unknown";

export { type Skin };

export async function classifySkin(imagePath: string): Promise<Skin> {
  const img = await loadImageRaw(imagePath);
  return detectSkin(img);
}

function detectSkin(img: ImageData): Skin {
  let grayFace = 0;
  let grayBorder = 0;
  let orangePixels = 0;
  let darkPixels = 0;
  const sampleStep = 3;
  let total = 0;

  for (let y = 0; y < img.height; y += sampleStep) {
    for (let x = 0; x < img.width; x += sampleStep) {
      total++;
      const [r, g, b] = getPixel(img, x, y);

      // Clean One: orange hidden cells + dark background
      if (isCleanOneOrange(r, g, b)) orangePixels++;
      if (isCleanOneDark(r, g, b)) darkPixels++;
      const gray = (r + g + b) / 3;

      // Classic: gray face + gray border
      if (Math.max(r, g, b) - Math.min(r, g, b) <= 15) {
        if (gray >= 185 && gray <= 205) grayFace++;
        if (gray >= 120 && gray <= 136) grayBorder++;
      }
    }
  }

  const classicGrayPct = grayFace / total;
  const borderPct = grayBorder / total;
  const orangePct = orangePixels / total;
  const darkPct = darkPixels / total;

  // Classic skin: lots of 198 gray + 128 borders
  if (classicGrayPct > 0.15 && borderPct > 0.01) {
    return "classic";
  }

  // Clean One: orange hidden cells + dark background
  if (orangePct > 0.08 && darkPct > 0.08) {
    return "clean-one";
  }

  return "unknown";
}

// --- Main entry point ---

export async function detectBoard(imagePath: string): Promise<BoardDetectionResult | null> {
  const img = await loadImageRaw(imagePath);

  const skin = detectSkin(img);
  if (skin === "unknown") return null;

  if (skin === "classic") {
    const grid = detectClassicGrid(img);
    if (!grid) return null;

    let board: CellState[][] = [];
    for (let row = 0; row < grid.rows; row++) {
      const rowCells: CellState[] = [];
      const cellY = grid.rowBorders[row]!;
      const cellH = grid.rowBorders[row + 1]! - cellY;
      for (let col = 0; col < grid.cols; col++) {
        const cellX = grid.colBorders[col]!;
        const cellW = grid.colBorders[col + 1]! - cellX;
        // Use grid.cellSize but don't exceed the actual cell bounds
        const size = Math.min(grid.cellSize, cellW, cellH);
        const state = classifyClassicCell(img, cellX, cellY, size);
        rowCells.push(state);
      }
      board.push(rowCells);
    }

    // Trim edge rows/columns that are frame artifacts.
    // Frame rows: all hidden+empty. Frame columns: all hidden+empty, or
    // all the same single digit (e.g., a column of "7" from dark frame pixels).
    let { colBorders, rowBorders } = grid;
    let { rows, cols } = grid;

    function isFrameRow(r: CellState[]): boolean {
      if (r.every((c) => c === "hidden" || c === "empty")) return true;
      // Rows with many "8"s are non-board content (header/UI). In real
      // minesweeper, "8" (all 8 neighbors are mines) is essentially impossible.
      const eightCount = r.filter((c) => c === "8").length;
      if (eightCount > r.length * 0.25) return true;
      // Edge rows that are mostly empty with rare digits (7/8) are non-board.
      // "7" or "8" on an edge row is mathematically suspect — edge cells have
      // at most 5 neighbors, making high neighbor counts impossible.
      const emptyCount = r.filter((c) => c === "empty").length;
      if (emptyCount > r.length * 0.5 &&
          r.some((c) => c === "7" || c === "8")) return true;
      // Runs of 3+ rare digits (5-8) are non-board content (timer/score
      // display). These digits require most/all neighbors to be mines,
      // so consecutive runs are essentially impossible in real games.
      const rareDigits = new Set<CellState>(["5", "6", "7", "8"]);
      let run = 1;
      for (let i = 1; i < r.length; i++) {
        if (r[i] === r[i - 1] && rareDigits.has(r[i]!)) {
          run++;
          if (run >= 3) return true;
        } else {
          run = 1;
        }
      }
      return false;
    }

    function isFrameCol(colIdx: number): boolean {
      const states = board.map((r) => r[colIdx]!);
      // All hidden/empty
      if (states.every((c) => c === "hidden" || c === "empty")) return true;
      // All the same digit with enough cells to be confident it's a frame
      // artifact (e.g., a full column of "7"s from dark frame pixels).
      // Require at least 50% of the column to be the repeated digit.
      const nonEmpty = states.filter((c) => c !== "hidden" && c !== "empty");
      if (nonEmpty.length >= states.length * 0.5 &&
          nonEmpty.every((c) => c === nonEmpty[0])) return true;
      return false;
    }

    while (rows > 0 && isFrameRow(board[0]!)) {
      board.shift(); rowBorders = rowBorders.slice(1); rows--;
    }
    while (rows > 0 && isFrameRow(board[rows - 1]!)) {
      board.pop(); rowBorders = rowBorders.slice(0, -1); rows--;
    }
    while (cols > 0 && isFrameCol(0)) {
      for (const r of board) r.shift();
      colBorders = colBorders.slice(1); cols--;
    }
    while (cols > 0 && isFrameCol(cols - 1)) {
      for (const r of board) r.pop();
      colBorders = colBorders.slice(0, -1); cols--;
    }

    if (rows < 3 || cols < 3) return null;

    const x = colBorders[0]!;
    const y = rowBorders[0]!;
    const w = colBorders[cols]! - x;
    const h = rowBorders[rows]! - y;

    return {
      board,
      gridBounds: { x, y, width: w, height: h },
      cellSize: { width: grid.cellSize, height: grid.cellSize },
      colBorders,
      rowBorders,
      rows,
      cols,
      skin: "classic",
    };
  }

  if (skin === "clean-one") {
    const grid = detectCleanOneGrid(img);
    if (!grid) return null;

    let board: CellState[][] = [];
    for (let row = 0; row < grid.rows; row++) {
      const rowCells: CellState[] = [];
      const cellY = grid.rowBorders[row]!;
      const cellH = grid.rowBorders[row + 1]! - cellY;
      for (let col = 0; col < grid.cols; col++) {
        const cellX = grid.colBorders[col]!;
        const cellW = grid.colBorders[col + 1]! - cellX;
        rowCells.push(classifyCleanOneCell(img, cellX, cellY, cellW, cellH));
      }
      board.push(rowCells);
    }

    // Trim rows/cols from edges that don't contain real board content.
    // Real board rows have hidden cells or recognized numbers.
    // Edge rows with only empty+unknown are likely app UI (header/footer).
    let { colBorders, rowBorders } = grid;
    let { rows, cols } = grid;

    // Trim edge rows/cols that don't look like real board content.
    // Real board rows have multiple confident cells (hidden, flags, numbers).
    // Edge rows with mostly empty/unknown (plus maybe one stray detection)
    // are likely app UI or header/footer.
    function isNonBoardRow(r: CellState[]): boolean {
      const hidden = r.filter((c) => c === "hidden").length;
      const flags = r.filter((c) => c === "flag").length;
      const numbers = r.filter((c) => c >= "1" && c <= "8").length;
      // Keep row if it has any hidden cells
      if (hidden > 0) return false;
      // Trim rows dominated by flags (>40%) — likely UI with false flag detections
      if (flags > r.length * 0.4) return true;
      // Rows without hidden cells need substantial content to be kept.
      // Real revealed rows have many numbers; UI rows have a few scattered false positives.
      const confident = flags + numbers;
      return confident < r.length * 0.2;
    }
    function isNonBoardCol(colIdx: number): boolean {
      const colCells = board.map((r) => r[colIdx]!);
      const hidden = colCells.filter((c) => c === "hidden").length;
      const flags = colCells.filter((c) => c === "flag").length;
      const numbers = colCells.filter((c) => c >= "1" && c <= "8").length;
      if (hidden > 0) return false;
      if (flags > colCells.length * 0.4) return true;
      const confident = flags + numbers;
      return confident < colCells.length * 0.2;
    }

    // Trim top rows
    while (rows > 0 && isNonBoardRow(board[0]!)) {
      board.shift();
      rowBorders = rowBorders.slice(1);
      rows--;
    }
    // Trim bottom rows
    while (rows > 0 && isNonBoardRow(board[rows - 1]!)) {
      board.pop();
      rowBorders = rowBorders.slice(0, -1);
      rows--;
    }
    // Trim left cols
    while (cols > 0 && isNonBoardCol(0)) {
      board = board.map((r) => r.slice(1));
      colBorders = colBorders.slice(1);
      cols--;
    }
    // Trim right cols
    while (cols > 0 && isNonBoardCol(cols - 1)) {
      board = board.map((r) => r.slice(0, -1));
      colBorders = colBorders.slice(0, -1);
      cols--;
    }

    if (rows < 3 || cols < 3) return null;

    const x = colBorders[0]!;
    const y = rowBorders[0]!;
    const w = colBorders[cols]! - x;
    const h = rowBorders[rows]! - y;

    return {
      board,
      gridBounds: { x, y, width: w, height: h },
      cellSize: { width: grid.cellWidth, height: grid.cellHeight },
      colBorders,
      rowBorders,
      rows,
      cols,
      skin: "clean-one",
    };
  }

  return null;
}
