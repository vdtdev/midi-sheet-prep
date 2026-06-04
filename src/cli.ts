#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Command } from "commander";
import midiPkg from "@tonejs/midi";
const { Midi } = midiPkg;
import { buildCombinedArrangement } from "./combined.js";
import { transform } from "./transform.js";
import { formatSummary } from "./summary.js";

const program = new Command();

program
  .name("midi-sheet-prep")
  .description(
    "Octave-shift and clef-split a MIDI file so it fits a piano grand staff, plus emit a combined two-hand playable arrangement.",
  )
  .argument("<input>", "path to the input .mid file")
  .option(
    "-o, --output <path>",
    "path for the prepared output .mid (default: <input>.prepped.mid)",
  )
  .action(async (input: string, opts: { output?: string }) => {
    const inputPath = resolve(input);
    const outputPath = opts.output
      ? resolve(opts.output)
      : defaultOutputPath(inputPath);

    const bytes = await readFile(inputPath);
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    const midi = new Midi(ab);

    const combined = buildCombinedArrangement(midi);
    const { midi: outputMidi, decisions } = transform(midi, combined);

    await writeFile(outputPath, Buffer.from(outputMidi.toArray()));

    process.stdout.write(`Input:  ${inputPath}\n`);
    process.stdout.write(`Output: ${outputPath}\n\n`);
    process.stdout.write(formatSummary(decisions, combined.stats));
    process.stdout.write("\n");
  });

function defaultOutputPath(inputPath: string): string {
  const dir = dirname(inputPath);
  const ext = extname(inputPath);
  const base = basename(inputPath, ext);
  return join(dir, `${base}.prepped${ext || ".mid"}`);
}

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
