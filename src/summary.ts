import type { ChannelDecision } from "./transform.js";
import type { CombinedStats } from "./combined.js";
import { HAND_SPAN_MAX } from "./combined.js";

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

export function midiNumberToName(n: number): string {
  const pc = ((n % 12) + 12) % 12;
  const octave = Math.floor(n / 12) - 1;
  return `${NOTE_NAMES[pc]}${octave}`;
}

function fmtRange(r: { min: number; max: number } | null): string {
  if (!r) return "—";
  return `${midiNumberToName(r.min)}–${midiNumberToName(r.max)} (${r.min}–${r.max})`;
}

function fmtShift(semitones: number): string {
  if (semitones === 0) return "+0 oct";
  const oct = semitones / 12;
  const sign = oct >= 0 ? "+" : "";
  return `${sign}${oct} oct`;
}

export function formatSummary(
  decisions: ChannelDecision[],
  combined: CombinedStats,
): string {
  const lines: string[] = [];
  for (const d of decisions) {
    const { source } = d;
    const channelLabel = `Channel ${source.channel + 1}`;
    const trackName = source.track.name?.trim();
    const instrName = source.track.instrument?.name;
    const header = [channelLabel, trackName, instrName]
      .filter((s) => s && s.length > 0)
      .join(" — ");
    lines.push(header);

    if (source.clef === "drums") {
      lines.push(
        `  Passed through unchanged (${d.outputs[0]?.noteCount ?? 0} notes)`,
      );
      lines.push("");
      continue;
    }
    if (source.clef === "empty" || source.stats === null) {
      lines.push("  (no notes)");
      lines.push("");
      continue;
    }

    const s = source.stats;
    lines.push(
      `  Notes: ${s.count}   Range: ${midiNumberToName(s.min)}–${midiNumberToName(s.max)} (${s.min}–${s.max})   Median: ${midiNumberToName(s.median)} (${s.median})`,
    );
    if (source.clef === "split") {
      lines.push(`  Decision: SPLIT at C4`);
      for (const out of d.outputs) {
        lines.push(
          `    ${out.clef === "treble" ? "Treble" : "Bass  "}: ${String(out.noteCount).padStart(5)} notes, shift ${fmtShift(out.shiftSemitones)}  → range ${fmtRange(out.postShiftRange)}`,
        );
      }
    } else {
      const out = d.outputs[0]!;
      lines.push(
        `  Decision: ${out.clef.toUpperCase()}   shift ${fmtShift(out.shiftSemitones)}  → range ${fmtRange(out.postShiftRange)}`,
      );
    }
    lines.push("");
  }

  lines.push("Combined two-hand arrangement");
  lines.push(`  Strategy: ${combined.strategy}`);
  if (combined.channelClassifications.length > 0) {
    for (const c of combined.channelClassifications) {
      lines.push(
        `    ch${c.channel + 1} "${c.trackName}": ${c.classification} (polyphony ${c.polyphony.toFixed(2)}) → ${c.assignedTo}`,
      );
    }
  }
  lines.push(
    `  Source notes: ${combined.sourceNoteCount}  (from non-drum channels)`,
  );
  lines.push(
    `  Assigned: ${combined.assignedTreble + combined.assignedBass}  (treble: ${combined.assignedTreble}, bass: ${combined.assignedBass})`,
  );
  lines.push(
    `  Dropped (middle voices, chord too dense): ${combined.droppedMiddle}`,
  );
  lines.push(
    `  Evicted (truncated to make room for extremes): ${combined.evicted}`,
  );
  lines.push(
    `  Shifts: treble ${fmtShift(combined.trebleShift * 12)}, bass ${fmtShift(combined.bassShift * 12)}`,
  );
  lines.push(
    `  Treble range: ${fmtRange(combined.trebleRange)}   Bass range: ${fmtRange(combined.bassRange)}`,
  );
  lines.push(`  Hand span limit: ${HAND_SPAN_MAX} semitones`);
  return lines.join("\n");
}
