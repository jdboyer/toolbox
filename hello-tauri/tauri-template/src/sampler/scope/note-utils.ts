/**
 * Utility functions for converting musical note names to frequencies
 */

/**
 * Convert a musical note string to frequency in Hz
 *
 * Supports the following formats:
 * - "C4", "D#5", "Bb3" (note name + octave)
 * - "C#4", "Db4" (sharp or flat notation)
 * - Scientific pitch notation (middle C = C4 = 261.63 Hz)
 *
 * @param note Musical note string (e.g., "C4", "A#3", "Bb5")
 * @returns Frequency in Hz, or null if the note string is invalid
 *
 * @example
 * noteToFrequency("A4")   // 440.0 Hz
 * noteToFrequency("C4")   // 261.63 Hz
 * noteToFrequency("C#4")  // 277.18 Hz
 * noteToFrequency("Db4")  // 277.18 Hz
 */
export function noteToFrequency(note: string): number | null {
  // Trim and convert to uppercase
  const trimmed = note.trim().toUpperCase();

  // Regular expression to parse note format: Letter + optional sharp/flat + octave number
  const match = trimmed.match(/^([A-G])([#B]?)(-?\d+)$/);

  if (!match) {
    return null;
  }

  const [, noteName, accidental, octaveStr] = match;
  const octave = parseInt(octaveStr, 10);

  // Map note names to semitones (C = 0)
  const noteOffsets: Record<string, number> = {
    'C': 0,
    'D': 2,
    'E': 4,
    'F': 5,
    'G': 7,
    'A': 9,
    'B': 11,
  };

  // Get base semitone offset
  let semitone = noteOffsets[noteName];

  if (semitone === undefined) {
    return null;
  }

  // Apply accidental (sharp or flat)
  if (accidental === '#') {
    semitone += 1;
  } else if (accidental === 'B') {
    semitone -= 1;
  }

  // Calculate MIDI note number
  // C4 = MIDI 60 (middle C in scientific pitch notation)
  const midiNote = (octave + 1) * 12 + semitone;

  // Convert MIDI note to frequency
  // A4 (MIDI 69) = 440 Hz
  return midiToFrequency(midiNote);
}

/**
 * Convert MIDI note number to frequency in Hz
 *
 * @param midiNote MIDI note number (0-127)
 * @returns Frequency in Hz
 *
 * @example
 * midiToFrequency(69)  // 440.0 Hz (A4)
 * midiToFrequency(60)  // 261.63 Hz (C4)
 */
export function midiToFrequency(midiNote: number): number {
  // A4 (MIDI note 69) = 440 Hz
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

/**
 * Convert frequency in Hz to the nearest musical note
 *
 * @param frequency Frequency in Hz
 * @returns Object containing note name, octave, MIDI number, and cents off
 *
 * @example
 * frequencyToNote(440)  // { note: "A", octave: 4, midi: 69, cents: 0 }
 * frequencyToNote(442)  // { note: "A", octave: 4, midi: 69, cents: 7.85 }
 */
export function frequencyToNote(frequency: number): {
  note: string;
  octave: number;
  midi: number;
  cents: number;
} {
  // Convert frequency to MIDI note number (can be fractional)
  const midiNote = 69 + 12 * Math.log2(frequency / 440);
  const roundedMidi = Math.round(midiNote);

  // Calculate how many cents off from the nearest note
  const cents = (midiNote - roundedMidi) * 100;

  // Convert MIDI number back to note name and octave
  const octave = Math.floor(roundedMidi / 12) - 1;
  const noteIndex = roundedMidi % 12;

  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const note = noteNames[noteIndex];

  return {
    note,
    octave,
    midi: roundedMidi,
    cents: Math.round(cents * 100) / 100, // Round to 2 decimal places
  };
}

/**
 * Get frequency range for a musical note range
 *
 * @param startNote Starting note (e.g., "C2")
 * @param endNote Ending note (e.g., "C8")
 * @returns Object with fMin and fMax frequencies, or null if invalid
 *
 * @example
 * getNoteRange("C2", "C8")  // { fMin: 65.41 Hz, fMax: 4186.01 Hz }
 */
export function getNoteRange(startNote: string, endNote: string): { fMin: number; fMax: number } | null {
  const fMin = noteToFrequency(startNote);
  const fMax = noteToFrequency(endNote);

  if (fMin === null || fMax === null) {
    return null;
  }

  return {
    fMin: Math.min(fMin, fMax),
    fMax: Math.max(fMin, fMax),
  };
}
