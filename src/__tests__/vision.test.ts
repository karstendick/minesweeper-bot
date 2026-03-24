/**
 * Vision pipeline tests.
 *
 * Compares detectBoard output against ground truth files in data/ground-truth/.
 * Ground truth format: one character per cell.
 *   . = hidden, F = flag, (space) = empty, 1-8 = numbers, ? = don't care
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { detectBoard, type CellState } from "../vision.js";

import { existsSync } from "node:fs";

const ROOT = join(import.meta.dirname, "..", "..");
const TEST_IMAGES_DIR = join(ROOT, "data", "test-images");
const IMAGES_DIR = join(ROOT, "data", "images");
const GT_DIR = join(ROOT, "data", "ground-truth");

function imagePath(name: string): string {
  const testPath = join(TEST_IMAGES_DIR, name);
  if (existsSync(testPath)) return testPath;
  return join(IMAGES_DIR, name);
}

const charMap: Record<string, CellState> = {
  ".": "hidden",
  " ": "empty",
  F: "flag",
  "*": "mine",
  "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "6": "6", "7": "7", "8": "8",
};

const reverseCharMap: Record<CellState, string> = {
  hidden: ".", empty: " ", flag: "F", mine: "*", unknown: "?",
  "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "6": "6", "7": "7", "8": "8",
};

function parseGroundTruth(text: string): (CellState | null)[][] {
  return text.trimEnd().split("\n").map((line) => {
    return [...line].map((ch) => {
      if (ch === "?") return null;
      return charMap[ch] ?? null;
    });
  });
}

/**
 * Find the best row/col alignment offset between the detected grid
 * and the ground truth (allows ±3 shift to handle edge trimming differences).
 */
function findAlignment(
  gt: (CellState | null)[][],
  board: CellState[][],
  rows: number,
  cols: number,
): { dr: number; dc: number } {
  let bestDr = 0, bestDc = 0, bestScore = -1;
  for (let dr = -3; dr <= 3; dr++) {
    for (let dc = -3; dc <= 3; dc++) {
      let score = 0;
      for (let row = 0; row < gt.length; row++) {
        for (let col = 0; col < (gt[row]?.length ?? 0); col++) {
          const expected = gt[row]![col];
          if (expected === null) continue;
          const detRow = row + dr;
          const detCol = col + dc;
          if (detRow < 0 || detRow >= rows || detCol < 0 || detCol >= cols) continue;
          if (board[detRow]![detCol] === expected) score++;
        }
      }
      if (score > bestScore) { bestScore = score; bestDr = dr; bestDc = dc; }
    }
  }
  return { dr: bestDr, dc: bestDc };
}

// Generate one test per ground truth file
const gtFiles = readdirSync(GT_DIR).filter((f) => f.endsWith(".txt"));

describe("Clean One grid detection", () => {
  for (const gtFile of gtFiles) {
    const imageName = gtFile.replace(".txt", "");

    test(imageName, async () => {
      const gtText = readFileSync(join(GT_DIR, gtFile), "utf-8");
      const gt = parseGroundTruth(gtText);
      const result = await detectBoard(imagePath(imageName));
      expect(result).not.toBeNull();
      if (!result) return;

      const { dr, dc } = findAlignment(gt, result.board, result.rows, result.cols);

      const errors: string[] = [];
      for (let row = 0; row < gt.length; row++) {
        for (let col = 0; col < (gt[row]?.length ?? 0); col++) {
          const expected = gt[row]![col];
          if (expected === null) continue;

          const detRow = row + dr;
          const detCol = col + dc;
          if (detRow < 0 || detRow >= result.rows || detCol < 0 || detCol >= result.cols) {
            errors.push(`(${col},${row}): expected '${reverseCharMap[expected]}', got OUT OF BOUNDS`);
            continue;
          }
          const detected = result.board[detRow]![detCol] ?? "unknown";
          if (detected !== expected) {
            errors.push(`(${col},${row}): expected '${reverseCharMap[expected]}', got '${reverseCharMap[detected]}'`);
          }
        }
      }

      expect(errors, errors.join("\n")).toHaveLength(0);
    });
  }
});
