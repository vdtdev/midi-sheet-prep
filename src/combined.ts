import type { Midi } from "@tonejs/midi";
import { DRUM_CHANNEL } from "./analyze.js";
import { bestOctaveShift } from "./transpose.js";

export const HAND_SPAN_MAX = 10;

export interface CombinedNote {
  midi: number;
  ticks: number;
  durationTicks: number;
  velocity: number;
  noteOffVelocity: number;
}

export interface CombinedStats {
  sourceNoteCount: number;
  assignedTreble: number;
  assignedBass: number;
  droppedMiddle: number;
  evicted: number;
  trebleShift: number;
  bassShift: number;
  trebleRange: { min: number; max: number } | null;
  bassRange: { min: number; max: number } | null;
}

export interface CombinedArrangement {
  treble: CombinedNote[];
  bass: CombinedNote[];
  stats: CombinedStats;
}

interface ActiveNote {
  midi: number;
  emitted: CombinedNote;
}

export function buildCombinedArrangement(midi: Midi): CombinedArrangement {
  const allNotes: CombinedNote[] = [];
  for (const track of midi.tracks) {
    if (track.channel === DRUM_CHANNEL) continue;
    for (const n of track.notes) {
      allNotes.push({
        midi: n.midi,
        ticks: n.ticks,
        durationTicks: n.durationTicks,
        velocity: n.velocity,
        noteOffVelocity: n.noteOffVelocity,
      });
    }
  }
  allNotes.sort((a, b) => a.ticks - b.ticks || b.midi - a.midi);

  const treble: ActiveNote[] = [];
  const bass: ActiveNote[] = [];
  const trebleOut: CombinedNote[] = [];
  const bassOut: CombinedNote[] = [];
  let droppedMiddle = 0;
  let evicted = 0;

  const removeExpired = (now: number) => {
    for (let i = treble.length - 1; i >= 0; i--) {
      const a = treble[i]!;
      if (a.emitted.ticks + a.emitted.durationTicks <= now) treble.splice(i, 1);
    }
    for (let i = bass.length - 1; i >= 0; i--) {
      const a = bass[i]!;
      if (a.emitted.ticks + a.emitted.durationTicks <= now) bass.splice(i, 1);
    }
  };

  const handMin = (hand: ActiveNote[]) =>
    hand.length === 0
      ? Infinity
      : hand.reduce((m, a) => Math.min(m, a.midi), Infinity);
  const handMax = (hand: ActiveNote[]) =>
    hand.length === 0
      ? -Infinity
      : hand.reduce((m, a) => Math.max(m, a.midi), -Infinity);
  const handMedian = (hand: ActiveNote[]) => {
    if (hand.length === 0) return NaN;
    const sorted = hand.map((a) => a.midi).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;
  };
  const spanIfAdded = (hand: ActiveNote[], pitch: number) => {
    if (hand.length === 0) return 0;
    return Math.max(handMax(hand), pitch) - Math.min(handMin(hand), pitch);
  };

  const evictLowestFromTreble = (atTick: number) => {
    if (treble.length === 0) return false;
    let idx = 0;
    for (let i = 1; i < treble.length; i++) {
      if (treble[i]!.midi < treble[idx]!.midi) idx = i;
    }
    const ev = treble[idx]!;
    treble.splice(idx, 1);
    const newDur = atTick - ev.emitted.ticks;
    if (newDur > 0) {
      ev.emitted.durationTicks = newDur;
    } else {
      const i = trebleOut.indexOf(ev.emitted);
      if (i >= 0) trebleOut.splice(i, 1);
    }
    evicted++;
    return true;
  };

  const evictHighestFromBass = (atTick: number) => {
    if (bass.length === 0) return false;
    let idx = 0;
    for (let i = 1; i < bass.length; i++) {
      if (bass[i]!.midi > bass[idx]!.midi) idx = i;
    }
    const ev = bass[idx]!;
    bass.splice(idx, 1);
    const newDur = atTick - ev.emitted.ticks;
    if (newDur > 0) {
      ev.emitted.durationTicks = newDur;
    } else {
      const i = bassOut.indexOf(ev.emitted);
      if (i >= 0) bassOut.splice(i, 1);
    }
    evicted++;
    return true;
  };

  for (const n of allNotes) {
    removeExpired(n.ticks);

    const trebleSpan = spanIfAdded(treble, n.midi);
    const bassSpan = spanIfAdded(bass, n.midi);
    const trebleFitsCross = bass.length === 0 || n.midi >= handMax(bass);
    const bassFitsCross = treble.length === 0 || n.midi <= handMin(treble);
    const trebleOk = trebleSpan <= HAND_SPAN_MAX && trebleFitsCross;
    const bassOk = bassSpan <= HAND_SPAN_MAX && bassFitsCross;

    let target: "T" | "B" | null = null;

    if (trebleOk && bassOk) {
      const tDist = treble.length
        ? Math.abs(n.midi - handMedian(treble))
        : Math.abs(n.midi - 71);
      const bDist = bass.length
        ? Math.abs(n.midi - handMedian(bass))
        : Math.abs(n.midi - 50);
      if (tDist < bDist) target = "T";
      else if (bDist < tDist) target = "B";
      else target = n.midi >= 60 ? "T" : "B";
    } else if (trebleOk) {
      target = "T";
    } else if (bassOk) {
      target = "B";
    }

    if (target === null) {
      const globalMax = Math.max(handMax(treble), handMax(bass));
      const globalMin = Math.min(handMin(treble), handMin(bass));

      if (n.midi >= globalMax) {
        while (true) {
          const s = spanIfAdded(treble, n.midi);
          const cross = bass.length > 0 && n.midi < handMax(bass);
          if (s <= HAND_SPAN_MAX && !cross) {
            target = "T";
            break;
          }
          if (!evictLowestFromTreble(n.ticks)) break;
        }
      } else if (n.midi <= globalMin) {
        while (true) {
          const s = spanIfAdded(bass, n.midi);
          const cross = treble.length > 0 && n.midi > handMin(treble);
          if (s <= HAND_SPAN_MAX && !cross) {
            target = "B";
            break;
          }
          if (!evictHighestFromBass(n.ticks)) break;
        }
      }

      if (target === null) {
        droppedMiddle++;
        continue;
      }
    }

    const emitted: CombinedNote = {
      midi: n.midi,
      ticks: n.ticks,
      durationTicks: n.durationTicks,
      velocity: n.velocity,
      noteOffVelocity: n.noteOffVelocity,
    };
    const active: ActiveNote = { midi: n.midi, emitted };
    if (target === "T") {
      treble.push(active);
      trebleOut.push(emitted);
    } else {
      bass.push(active);
      bassOut.push(emitted);
    }
  }

  const treblePitchesPreShift = trebleOut.map((n) => n.midi);
  const bassPitchesPreShift = bassOut.map((n) => n.midi);
  const trebleShift = bestOctaveShift(treblePitchesPreShift, "treble");
  const bassShift = bestOctaveShift(bassPitchesPreShift, "bass");
  for (const n of trebleOut) n.midi += trebleShift * 12;
  for (const n of bassOut) n.midi += bassShift * 12;

  const range = (notes: CombinedNote[]) =>
    notes.length === 0
      ? null
      : {
          min: notes.reduce((m, n) => Math.min(m, n.midi), Infinity),
          max: notes.reduce((m, n) => Math.max(m, n.midi), -Infinity),
        };

  return {
    treble: trebleOut,
    bass: bassOut,
    stats: {
      sourceNoteCount: allNotes.length,
      assignedTreble: trebleOut.length,
      assignedBass: bassOut.length,
      droppedMiddle,
      evicted,
      trebleShift,
      bassShift,
      trebleRange: range(trebleOut),
      bassRange: range(bassOut),
    },
  };
}
