# midi-sheet-prep

A vibe-coded CLI tool that attempts to prepare a midi file so it can be used to generate piano sheet music more easily.

## What it tries to do

- **Pick a clef for each channel.** Based on the channel's note range, decide whether it should be notated in treble clef, bass clef, or split across both at middle C.
- **Octave-shift each channel** so its notes land inside the comfortable reading range of the chosen clef, reducing ledger lines. Transposition is octaves only — the original key and pitch classes are preserved.
- **Pass percussion through untouched.** MIDI channel 10 (drum kit) is copied verbatim — note numbers there are drum mappings, not pitches.
- **Produce an extra "combined two-hand" arrangement.** A separate pair of tracks (treble + bass) merges all non-drum channels into something a single pianist could realistically play with two hands.
- **Respect playability constraints in the combined arrangement.**
  - No more than ~10 semitones (a 10th) spanned by either hand at any instant.
  - When too many notes sound at once, middle voices are dropped — the highest and lowest are preserved.
- **Print a per-channel summary** explaining every decision: ranges, medians, octave shifts applied, classification, eviction counts.

## How it does it

The pipeline runs in four stages:

1. **Analyze each channel.** Compute min/max/median pitch. If all notes are above middle C → treble; all below → bass; spanning both → split at C4.
2. **Choose an octave shift.** For each channel (and each half of a split channel), search octave shifts in the range `[-4, +4]` and pick the one that puts the most notes inside the clef's comfortable range. Treble comfort = `C4–A5` (centered on B4); bass comfort = `E2–C4` (centered on D3).
3. **Build the combined two-hand arrangement.**
   - Classify each non-drum channel as *melodic* or *chord-like* using onset-grouping polyphony: count the average number of notes whose onsets fall within a tiny tolerance of each other (relative to the file's PPQ). A monophonic line scores ≈ 1.0; a 3-note chord channel scores ≈ 3.0. Threshold: `>= 1.5` → chord-like.
   - All melodic channels go to the right hand (treble); all chord-like channels go to the left hand (bass).
   - Apply the octave-shift step to each hand independently so the merged stream sits on its target staff.
   - Walk events chronologically and enforce the 10-semitone hand span: if a new note pushes a hand over the limit, evict the *furthest interior* sustaining note (truncating its duration). Notes that are neither the new highest nor new lowest in a dense chord are dropped.
   - If every channel falls into the same bucket (all melodic or all chord-like), fall back to a dynamic per-note split that follows the same span/eviction rules.
4. **Emit a new MIDI file** containing the per-channel transposed tracks, the drum tracks unchanged, and the two combined-arrangement tracks. Tempo map, time signatures, and PPQ are preserved.

## Usage

Requires Node.js

```bash
nvm use
npm install
npm run build
```

Run the CLI:

```bash
node dist/cli.js <input.mid> [-o <output.mid>]
```

Or, after `npm link`, as a global command:

```bash
midi-sheet-prep <input.mid> [-o <output.mid>]
```

### Options

| Flag | Description |
| ---- | ----------- |
| `<input>` | Path to the input `.mid` file (required). |
| `-o, --output <path>` | Path for the prepared output file. Defaults to `<input-basename>.prepped.mid` next to the input. |
| `-h, --help` | Show help. |

### Example

```bash
node dist/cli.js samples/simple-single-channel.mid -o samples/simple-single-channel.prepped.mid
```

Sample output:

```
Channel 1 — Classic Piano2 — acoustic grand piano
  Notes: 150   Range: C#2–G#2 (37–44)   Median: E2 (40)
  Decision: BASS   shift +1 oct  → range C#3–G#3 (49–56)

Channel 2 — Classic Piano — acoustic grand piano
  Notes: 258   Range: C#1–A#3 (25–58)   Median: F#2 (42)
  Decision: BASS   shift +0 oct  → range C#1–A#3 (25–58)

Combined two-hand arrangement
  Strategy: channel-grouped
    ch2 "Classic Piano": melodic (polyphony 1.17) → treble
    ch1 "Classic Piano2": chord-like (polyphony 2.50) → bass
  Source notes: 440  (from non-drum channels)
  Assigned: 411  (treble: 261, bass: 150)
  ...
```

Open the resulting `.prepped.mid` in MuseScore, Logic, or any notation tool to render it as sheet music.