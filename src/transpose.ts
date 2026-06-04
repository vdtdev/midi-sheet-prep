export type ClefTarget = "treble" | "bass";

export interface ClefRange {
  lo: number;
  hi: number;
  center: number;
}

export const CLEF_RANGES: Record<ClefTarget, ClefRange> = {
  treble: { lo: 60, hi: 81, center: 71 },
  bass: { lo: 40, hi: 60, center: 50 },
};

const SEARCH_OCTAVES = [-4, -3, -2, -1, 0, 1, 2, 3, 4];

export function bestOctaveShift(pitches: number[], clef: ClefTarget): number {
  if (pitches.length === 0) return 0;
  const { lo, hi, center } = CLEF_RANGES[clef];
  const median = medianOf(pitches);

  let bestK = 0;
  let bestScore: [number, number, number] | null = null;

  for (const k of SEARCH_OCTAVES) {
    const offset = k * 12;
    let outOfRange = 0;
    for (const p of pitches) {
      const shifted = p + offset;
      if (shifted < lo || shifted > hi) outOfRange++;
    }
    const score: [number, number, number] = [
      outOfRange,
      Math.abs(k),
      Math.abs(median + offset - center),
    ];
    if (bestScore === null || lexCompare(score, bestScore) < 0) {
      bestScore = score;
      bestK = k;
    }
  }
  return bestK;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function lexCompare(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}
