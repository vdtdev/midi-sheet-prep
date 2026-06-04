import type { Midi } from "@tonejs/midi";
import type { Note } from "@tonejs/midi/dist/Note";
import type { Track } from "@tonejs/midi/dist/Track";

export const MIDDLE_C = 60;
export const DRUM_CHANNEL = 9;

export interface ChannelStats {
  min: number;
  max: number;
  median: number;
  count: number;
}

export type ClefDecision = "treble" | "bass" | "split";

export interface AnalyzedChannel {
  track: Track;
  trackIndex: number;
  channel: number;
  isDrum: boolean;
  stats: ChannelStats | null;
  clef: ClefDecision | "drums" | "empty";
}

export function channelStats(notes: Note[]): ChannelStats | null {
  if (notes.length === 0) return null;
  const pitches = notes.map((n) => n.midi).sort((a, b) => a - b);
  const min = pitches[0]!;
  const max = pitches[pitches.length - 1]!;
  const mid = pitches.length >> 1;
  const median =
    pitches.length % 2 === 1
      ? pitches[mid]!
      : Math.round((pitches[mid - 1]! + pitches[mid]!) / 2);
  return { min, max, median, count: pitches.length };
}

export function decideClef(stats: ChannelStats): ClefDecision {
  if (stats.max < MIDDLE_C) return "bass";
  if (stats.min >= MIDDLE_C) return "treble";
  return "split";
}

export function analyzeChannels(midi: Midi): AnalyzedChannel[] {
  return midi.tracks.map((track, trackIndex) => {
    const isDrum = track.channel === DRUM_CHANNEL;
    if (isDrum) {
      return {
        track,
        trackIndex,
        channel: track.channel,
        isDrum: true,
        stats: channelStats(track.notes),
        clef: "drums",
      };
    }
    const stats = channelStats(track.notes);
    if (!stats) {
      return {
        track,
        trackIndex,
        channel: track.channel,
        isDrum: false,
        stats: null,
        clef: "empty",
      };
    }
    return {
      track,
      trackIndex,
      channel: track.channel,
      isDrum: false,
      stats,
      clef: decideClef(stats),
    };
  });
}
