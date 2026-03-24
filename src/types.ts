export type CellState =
  | "hidden"
  | "empty"
  | "flag"
  | "mine"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "unknown";

export interface BoardDetectionResult {
  board: CellState[][];
  gridBounds: { x: number; y: number; width: number; height: number };
  cellSize: { width: number; height: number };
  colBorders: number[];
  rowBorders: number[];
  rows: number;
  cols: number;
  skin: string;
}

export interface ImageData {
  data: Buffer;
  width: number;
  height: number;
}

export const cellStateToChar: Record<CellState, string> = {
  hidden: ".",
  empty: " ",
  flag: "F",
  mine: "*",
  unknown: "?",
  "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "6": "6", "7": "7", "8": "8",
};

export const charToCellState: Record<string, CellState> = {
  ".": "hidden",
  " ": "empty",
  F: "flag",
  "*": "mine",
  "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "6": "6", "7": "7", "8": "8",
};

export function formatBoard(board: CellState[][]): string {
  return board.map((row) => row.map((c) => cellStateToChar[c]).join("")).join("\n");
}
