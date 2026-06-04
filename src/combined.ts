import type { Midi } from "@tonejs/midi";
import type { Track } from "@tonejs/midi/dist/Track";
import type { Note } from "@tonejs/midi/dist/Note";
import { DRUM_CHANNEL } from "./analyze.js";
import { bestOctaveShift } from "./transpose.js";

export const HAND_SPAN_MAX = 10;
// A channel is "chord-like" if the average number of notes per onset group
// (notes that start at the same instant, within a small tick tolerance) is at
// least this. A pure monophonic melody scores 1.0; chords score 2.0+.
export const POLYPHONY_THRESHOLD = 1.5;

export interface CombinedNote {
  midi: number;
  ticks: number;
  durationTicks: number;
  velocity: number;
  noteOffVelocity: number;
}

export interface ChannelClassification {
  channel: number;
  trackName: string;
  noteCount: number;
  polyphony: number;
  classification: "melodic" | "chord-like";
  assignedTo: "treble" | "bass";
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
  strategy: "channel-grouped" | "per-note-dynamic";
  channelClassifications: ChannelClassification[];
}

export interface CombinedArrangement {
  treble: CombinedNote[];
  bass: CombinedNote[];
  stats: CombinedStats;
}

interface ClassifiedTrack {
  track: Track;
  polyphony: number;
}

function polyphonyDensity(notes: Note[], ppq: number): number {
  if (notes.length === 0) return 0;
  // Group notes whose onsets fall within a small fraction of a quarter note
  // (1/32 of a beat) of each other. Mean group size measures chord-iness:
  // monophonic melody ≈ 1.0, 3-note chords ≈ 3.0, fast legato runs (overlapping
  // releases but staggered onsets) still ≈ 1.0.
  const tolerance = Math.max(1, Math.round(ppq / 32));
  const sortedTicks = notes.map((n) => n.ticks).sort((a, b) => a - b);
  let groups = 1;
  let prev = sortedTicks[0]!;
  for (let i = 1; i < sortedTicks.length; i++) {
    if (sortedTicks[i]! - prev > tolerance) {
      groups++;
      prev = sortedTicks[i]!;
    }
  }
  return notes.length / groups;
}

function toCombinedNote(n: Note): CombinedNote {
  return {
    midi: n.midi,
    ticks: n.ticks,
    durationTicks: n.durationTicks,
    velocity: n.velocity,
    noteOffVelocity: n.noteOffVelocity,
  };
}

function trackLabel(t: Track): string {
  return t.name?.trim() || `Channel ${t.channel + 1}`;
}

export function buildCombinedArrangement(midi: Midi): CombinedArrangement {
  const ppq = midi.header.ppq;
  const nonDrum: ClassifiedTrack[] = midi.tracks
    .filter((t) => t.channel !== DRUM_CHANNEL && t.notes.length > 0)
    .map((t) => ({ track: t, polyphony: polyphonyDensity(t.notes, ppq) }));

  const melodic = nonDrum.filter((c) => c.polyphony < POLYPHONY_THRESHOLD);
  const chordLike = nonDrum.filter((c) => c.polyphony >= POLYPHONY_THRESHOLD);

  if (melodic.length > 0 && chordLike.length > 0) {
    return buildByChannelGroup(melodic, chordLike);
  }
  return buildPerNoteDynamic(nonDrum);
}

function buildByChannelGroup(
  melodic: ClassifiedTrack[],
  chordLike: ClassifiedTrack[],
): CombinedArrangement {
  const sourceNoteCount =
    melodic.reduce((s, c) => s + c.track.notes.length, 0) +
    chordLike.reduce((s, c) => s + c.track.notes.length, 0);

  const trebleRaw: CombinedNote[] = melodic.flatMap((c) =>
    c.track.notes.map(toCombinedNote),
  );
  const bassRaw: CombinedNote[] = chordLike.flatMap((c) =>
    c.track.notes.map(toCombinedNote),
  );

  const trebleShift = bestOctaveShift(
    trebleRaw.map((n) => n.midi),
    "treble",
  );
  const bassShift = bestOctaveShift(
    bassRaw.map((n) => n.midi),
    "bass",
  );
  for (const n of trebleRaw) n.midi += trebleShift * 12;
  for (const n of bassRaw) n.midi += bassShift * 12;

  const tr = enforceHandSpan(trebleRaw);
  const br = enforceHandSpan(bassRaw);

  const classifications: ChannelClassification[] = [
    ...melodic.map((c) => ({
      channel: c.track.channel,
      trackName: trackLabel(c.track),
      noteCount: c.track.notes.length,
      polyphony: c.polyphony,
      classification: "melodic" as const,
      assignedTo: "treble" as const,
    })),
    ...chordLike.map((c) => ({
      channel: c.track.channel,
      trackName: trackLabel(c.track),
      noteCount: c.track.notes.length,
      polyphony: c.polyphony,
      classification: "chord-like" as const,
      assignedTo: "bass" as const,
    })),
  ];

  return {
    treble: tr.kept,
    bass: br.kept,
    stats: {
      sourceNoteCount,
      assignedTreble: tr.kept.length,
      assignedBass: br.kept.length,
      droppedMiddle: tr.dropped + br.dropped,
      evicted: tr.evicted + br.evicted,
      trebleShift,
      bassShift,
      trebleRange: rangeOf(tr.kept),
      bassRange: rangeOf(br.kept),
      strategy: "channel-grouped",
      channelClassifications: classifications,
    },
  };
}

interface ActiveNote {
  midi: number;
  emitted: CombinedNote;
}

function enforceHandSpan(notes: CombinedNote[]): {
  kept: CombinedNote[];
  dropped: number;
  evicted: number;
} {
  const sorted = [...notes].sort(
    (a, b) => a.ticks - b.ticks || b.midi - a.midi,
  );
  const active: ActiveNote[] = [];
  const kept: CombinedNote[] = [];
  let dropped = 0;
  let evicted = 0;

  const handMin = () =>
    active.length === 0
      ? Infinity
      : active.reduce((m, a) => Math.min(m, a.midi), Infinity);
  const handMax = () =>
    active.length === 0
      ? -Infinity
      : active.reduce((m, a) => Math.max(m, a.midi), -Infinity);
  const spanIfAdded = (pitch: number) =>
    active.length === 0 ? 0 : Math.max(pitch, handMax()) - Math.min(pitch, handMin());

  const evictLowest = (atTick: number) => {
    if (active.length === 0) return false;
    let idx = 0;
    for (let i = 1; i < active.length; i++) {
      if (active[i]!.midi < active[idx]!.midi) idx = i;
    }
    const ev = active[idx]!;
    active.splice(idx, 1);
    const newDur = atTick - ev.emitted.ticks;
    if (newDur > 0) {
      ev.emitted.durationTicks = newDur;
    } else {
      const ki = kept.indexOf(ev.emitted);
      if (ki >= 0) kept.splice(ki, 1);
    }
    evicted++;
    return true;
  };

  const evictHighest = (atTick: number) => {
    if (active.length === 0) return false;
    let idx = 0;
    for (let i = 1; i < active.length; i++) {
      if (active[i]!.midi > active[idx]!.midi) idx = i;
    }
    const ev = active[idx]!;
    active.splice(idx, 1);
    const newDur = atTick - ev.emitted.ticks;
    if (newDur > 0) {
      ev.emitted.durationTicks = newDur;
    } else {
      const ki = kept.indexOf(ev.emitted);
      if (ki >= 0) kept.splice(ki, 1);
    }
    evicted++;
    return true;
  };

  for (const n of sorted) {
    for (let i = active.length - 1; i >= 0; i--) {
      const a = active[i]!;
      if (a.emitted.ticks + a.emitted.durationTicks <= n.ticks) active.splice(i, 1);
    }

    if (spanIfAdded(n.midi) <= HAND_SPAN_MAX) {
      const emitted = { ...n };
      active.push({ midi: n.midi, emitted });
      kept.push(emitted);
      continue;
    }

    const globalMax = Math.max(handMax(), n.midi);
    const globalMin = Math.min(handMin(), n.midi);

    if (n.midi >= globalMax) {
      while (active.length > 0 && spanIfAdded(n.midi) > HAND_SPAN_MAX) {
        if (!evictLowest(n.ticks)) break;
      }
      if (spanIfAdded(n.midi) <= HAND_SPAN_MAX) {
        const emitted = { ...n };
        active.push({ midi: n.midi, emitted });
        kept.push(emitted);
      } else {
        dropped++;
      }
    } else if (n.midi <= globalMin) {
      while (active.length > 0 && spanIfAdded(n.midi) > HAND_SPAN_MAX) {
        if (!evictHighest(n.ticks)) break;
      }
      if (spanIfAdded(n.midi) <= HAND_SPAN_MAX) {
        const emitted = { ...n };
        active.push({ midi: n.midi, emitted });
        kept.push(emitted);
      } else {
        dropped++;
      }
    } else {
      dropped++;
    }
  }

  return { kept, dropped, evicted };
}

function rangeOf(notes: CombinedNote[]): { min: number; max: number } | null {
  if (notes.length === 0) return null;
  let mn = notes[0]!.midi;
  let mx = notes[0]!.midi;
  for (const n of notes) {
    if (n.midi < mn) mn = n.midi;
    if (n.midi > mx) mx = n.midi;
  }
  return { min: mn, max: mx };
}

// Fallback: dynamic per-note hand split when channel-classification is uniform.
function buildPerNoteDynamic(
  classified: ClassifiedTrack[],
): CombinedArrangement {
  const allNotes: CombinedNote[] = classified.flatMap((c) =>
    c.track.notes.map(toCombinedNote),
  );
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
  const minOf = (h: ActiveNote[]) =>
    h.length === 0 ? Infinity : h.reduce((m, a) => Math.min(m, a.midi), Infinity);
  const maxOf = (h: ActiveNote[]) =>
    h.length === 0 ? -Infinity : h.reduce((m, a) => Math.max(m, a.midi), -Infinity);
  const medianOf = (h: ActiveNote[]) => {
    if (h.length === 0) return NaN;
    const s = h.map((a) => a.midi).sort((x, y) => x - y);
    const mid = s.length >> 1;
    return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  };
  const spanAdd = (h: ActiveNote[], p: number) =>
    h.length === 0 ? 0 : Math.max(maxOf(h), p) - Math.min(minOf(h), p);

  const evictFromTreble = (atTick: number) => {
    if (treble.length === 0) return false;
    let idx = 0;
    for (let i = 1; i < treble.length; i++) {
      if (treble[i]!.midi < treble[idx]!.midi) idx = i;
    }
    const ev = treble[idx]!;
    treble.splice(idx, 1);
    const newDur = atTick - ev.emitted.ticks;
    if (newDur > 0) ev.emitted.durationTicks = newDur;
    else {
      const i = trebleOut.indexOf(ev.emitted);
      if (i >= 0) trebleOut.splice(i, 1);
    }
    evicted++;
    return true;
  };
  const evictFromBass = (atTick: number) => {
    if (bass.length === 0) return false;
    let idx = 0;
    for (let i = 1; i < bass.length; i++) {
      if (bass[i]!.midi > bass[idx]!.midi) idx = i;
    }
    const ev = bass[idx]!;
    bass.splice(idx, 1);
    const newDur = atTick - ev.emitted.ticks;
    if (newDur > 0) ev.emitted.durationTicks = newDur;
    else {
      const i = bassOut.indexOf(ev.emitted);
      if (i >= 0) bassOut.splice(i, 1);
    }
    evicted++;
    return true;
  };

  for (const n of allNotes) {
    removeExpired(n.ticks);
    const tSpan = spanAdd(treble, n.midi);
    const bSpan = spanAdd(bass, n.midi);
    const tCross = bass.length === 0 || n.midi >= maxOf(bass);
    const bCross = treble.length === 0 || n.midi <= minOf(treble);
    const tOk = tSpan <= HAND_SPAN_MAX && tCross;
    const bOk = bSpan <= HAND_SPAN_MAX && bCross;

    let target: "T" | "B" | null = null;
    if (tOk && bOk) {
      const tD = treble.length
        ? Math.abs(n.midi - medianOf(treble))
        : Math.abs(n.midi - 71);
      const bD = bass.length
        ? Math.abs(n.midi - medianOf(bass))
        : Math.abs(n.midi - 50);
      target = tD < bD ? "T" : bD < tD ? "B" : n.midi >= 60 ? "T" : "B";
    } else if (tOk) target = "T";
    else if (bOk) target = "B";

    if (target === null) {
      const gMax = Math.max(maxOf(treble), maxOf(bass));
      const gMin = Math.min(minOf(treble), minOf(bass));
      if (n.midi >= gMax) {
        while (true) {
          const cross = bass.length > 0 && n.midi < maxOf(bass);
          if (spanAdd(treble, n.midi) <= HAND_SPAN_MAX && !cross) {
            target = "T";
            break;
          }
          if (!evictFromTreble(n.ticks)) break;
        }
      } else if (n.midi <= gMin) {
        while (true) {
          const cross = treble.length > 0 && n.midi > minOf(treble);
          if (spanAdd(bass, n.midi) <= HAND_SPAN_MAX && !cross) {
            target = "B";
            break;
          }
          if (!evictFromBass(n.ticks)) break;
        }
      }
      if (target === null) {
        droppedMiddle++;
        continue;
      }
    }

    const emitted = { ...n };
    const active: ActiveNote = { midi: n.midi, emitted };
    if (target === "T") {
      treble.push(active);
      trebleOut.push(emitted);
    } else {
      bass.push(active);
      bassOut.push(emitted);
    }
  }

  const trebleShift = bestOctaveShift(trebleOut.map((n) => n.midi), "treble");
  const bassShift = bestOctaveShift(bassOut.map((n) => n.midi), "bass");
  for (const n of trebleOut) n.midi += trebleShift * 12;
  for (const n of bassOut) n.midi += bassShift * 12;

  const classifications: ChannelClassification[] = classified.map((c) => ({
    channel: c.track.channel,
    trackName: trackLabel(c.track),
    noteCount: c.track.notes.length,
    polyphony: c.polyphony,
    classification: c.polyphony >= POLYPHONY_THRESHOLD ? "chord-like" : "melodic",
    assignedTo: "treble",
  }));

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
      trebleRange: rangeOf(trebleOut),
      bassRange: rangeOf(bassOut),
      strategy: "per-note-dynamic",
      channelClassifications: classifications,
    },
  };
}
