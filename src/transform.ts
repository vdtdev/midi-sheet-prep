import midiPkg from "@tonejs/midi";
import type { Midi } from "@tonejs/midi";
const { Midi: MidiCtor } = midiPkg;
import type { Track } from "@tonejs/midi/dist/Track";
import type { Note } from "@tonejs/midi/dist/Note";
import {
  type AnalyzedChannel,
  DRUM_CHANNEL,
  MIDDLE_C,
} from "./analyze.js";
import { bestOctaveShift } from "./transpose.js";
import type { CombinedArrangement, CombinedNote } from "./combined.js";

export interface ChannelDecision {
  source: AnalyzedChannel;
  outputs: ChannelOutput[];
}

export interface ChannelOutput {
  clef: "treble" | "bass" | "drums" | "empty";
  shiftSemitones: number;
  noteCount: number;
  postShiftRange: { min: number; max: number } | null;
  trackLabel: string;
}

export interface TransformResult {
  midi: Midi;
  decisions: ChannelDecision[];
}

export function transform(
  input: Midi,
  combined: CombinedArrangement,
): TransformResult {
  const output = new MidiCtor();
  output.header.fromJSON(input.header.toJSON());
  output.name = input.name;

  const decisions: ChannelDecision[] = [];
  let nextFreeChannel = nextFreeChannelStart(input);

  for (const [trackIndex, track] of input.tracks.entries()) {
    const analyzed = makeAnalyzedShape(track, trackIndex);
    if (analyzed.isDrum) {
      const outTrack = output.addTrack();
      copyTrackMeta(track, outTrack, track.channel, track.name);
      for (const n of track.notes) addNote(outTrack, n.midi, n);
      decisions.push({
        source: analyzed,
        outputs: [
          {
            clef: "drums",
            shiftSemitones: 0,
            noteCount: track.notes.length,
            postShiftRange: rangeOf(track.notes.map((n) => n.midi)),
            trackLabel: track.name || `Channel ${track.channel + 1} (Drums)`,
          },
        ],
      });
      continue;
    }
    if (analyzed.stats === null) {
      decisions.push({
        source: analyzed,
        outputs: [
          {
            clef: "empty",
            shiftSemitones: 0,
            noteCount: 0,
            postShiftRange: null,
            trackLabel: track.name || `Channel ${track.channel + 1}`,
          },
        ],
      });
      continue;
    }

    if (analyzed.clef === "split") {
      const trebleNotes = track.notes.filter((n) => n.midi >= MIDDLE_C);
      const bassNotes = track.notes.filter((n) => n.midi < MIDDLE_C);

      const tShift = bestOctaveShift(
        trebleNotes.map((n) => n.midi),
        "treble",
      );
      const bShift = bestOctaveShift(
        bassNotes.map((n) => n.midi),
        "bass",
      );

      const trebleTrack = output.addTrack();
      copyTrackMeta(
        track,
        trebleTrack,
        track.channel,
        `${track.name || `Channel ${track.channel + 1}`} (treble)`,
      );
      for (const n of trebleNotes) addNote(trebleTrack, n.midi + tShift * 12, n);

      const bassChannel = nextFreeChannel++;
      const bassTrack = output.addTrack();
      copyTrackMeta(
        track,
        bassTrack,
        bassChannel,
        `${track.name || `Channel ${track.channel + 1}`} (bass)`,
      );
      for (const n of bassNotes) addNote(bassTrack, n.midi + bShift * 12, n);

      decisions.push({
        source: analyzed,
        outputs: [
          {
            clef: "treble",
            shiftSemitones: tShift * 12,
            noteCount: trebleNotes.length,
            postShiftRange: rangeOf(
              trebleNotes.map((n) => n.midi + tShift * 12),
            ),
            trackLabel: trebleTrack.name,
          },
          {
            clef: "bass",
            shiftSemitones: bShift * 12,
            noteCount: bassNotes.length,
            postShiftRange: rangeOf(
              bassNotes.map((n) => n.midi + bShift * 12),
            ),
            trackLabel: bassTrack.name,
          },
        ],
      });
      continue;
    }

    // treble-only or bass-only
    const clef = analyzed.clef as "treble" | "bass";
    const shift = bestOctaveShift(
      track.notes.map((n) => n.midi),
      clef,
    );
    const outTrack = output.addTrack();
    copyTrackMeta(
      track,
      outTrack,
      track.channel,
      track.name || `Channel ${track.channel + 1}`,
    );
    for (const n of track.notes) addNote(outTrack, n.midi + shift * 12, n);

    decisions.push({
      source: analyzed,
      outputs: [
        {
          clef,
          shiftSemitones: shift * 12,
          noteCount: track.notes.length,
          postShiftRange: rangeOf(
            track.notes.map((n) => n.midi + shift * 12),
          ),
          trackLabel: outTrack.name,
        },
      ],
    });
  }

  // Append combined two-hand arrangement tracks.
  if (combined.treble.length > 0 || combined.bass.length > 0) {
    const trebleChannel = nextFreeChannel++;
    const bassChannel = nextFreeChannel++;
    const trebleTrack = output.addTrack();
    trebleTrack.name = "Combined (treble)";
    trebleTrack.channel = trebleChannel;
    for (const n of combined.treble) addCombinedNote(trebleTrack, n);

    const bassTrack = output.addTrack();
    bassTrack.name = "Combined (bass)";
    bassTrack.channel = bassChannel;
    for (const n of combined.bass) addCombinedNote(bassTrack, n);
  }

  return { midi: output, decisions };
}

function makeAnalyzedShape(track: Track, trackIndex: number): AnalyzedChannel {
  // Reuse the analyze logic by importing if needed; here we just reconstruct
  // minimal info from the track. Caller of transform() typically already has
  // the analysis. This is defensive in case it's not threaded through.
  const notes = track.notes;
  const isDrum = track.channel === DRUM_CHANNEL;
  if (notes.length === 0) {
    return {
      track,
      trackIndex,
      channel: track.channel,
      isDrum,
      stats: null,
      clef: isDrum ? "drums" : "empty",
    };
  }
  const pitches = notes.map((n) => n.midi).sort((a, b) => a - b);
  const min = pitches[0]!;
  const max = pitches[pitches.length - 1]!;
  const mid = pitches.length >> 1;
  const median =
    pitches.length % 2 === 1
      ? pitches[mid]!
      : Math.round((pitches[mid - 1]! + pitches[mid]!) / 2);
  const stats = { min, max, median, count: pitches.length };
  let clef: AnalyzedChannel["clef"];
  if (isDrum) clef = "drums";
  else if (max < MIDDLE_C) clef = "bass";
  else if (min >= MIDDLE_C) clef = "treble";
  else clef = "split";
  return { track, trackIndex, channel: track.channel, isDrum, stats, clef };
}

function copyTrackMeta(
  src: Track,
  dst: Track,
  channel: number,
  name: string,
) {
  dst.name = name;
  dst.channel = channel;
  dst.instrument.fromJSON(src.instrument.toJSON());
}

function addNote(track: Track, midi: number, source: Note) {
  track.addNote({
    midi: clampMidi(midi),
    ticks: source.ticks,
    durationTicks: source.durationTicks,
    velocity: source.velocity,
    noteOffVelocity: source.noteOffVelocity,
  });
}

function addCombinedNote(track: Track, n: CombinedNote) {
  track.addNote({
    midi: clampMidi(n.midi),
    ticks: n.ticks,
    durationTicks: n.durationTicks,
    velocity: n.velocity,
    noteOffVelocity: n.noteOffVelocity,
  });
}

function clampMidi(midi: number): number {
  if (midi < 0) return 0;
  if (midi > 127) return 127;
  return midi;
}

function rangeOf(pitches: number[]): { min: number; max: number } | null {
  if (pitches.length === 0) return null;
  let min = pitches[0]!;
  let max = pitches[0]!;
  for (const p of pitches) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return { min, max };
}

function nextFreeChannelStart(midi: Midi): number {
  const used = new Set<number>();
  for (const t of midi.tracks) used.add(t.channel);
  for (let c = 0; c < 16; c++) {
    if (c === DRUM_CHANNEL) continue;
    if (!used.has(c)) return c;
  }
  return 0;
}
