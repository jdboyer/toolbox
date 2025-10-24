/**
 * Example usage of the WebGPU CQT implementation
 */

import { computeCQT, magnitudesToDB, type CQTConfig } from "./cqt.ts";

// Example 1: Basic usage with synthetic audio
async function basicExample() {
  console.log("=== Basic CQT Example ===\n");

  // Generate a simple 440 Hz tone
  const sampleRate = 44100;
  const duration = 1.0; // 1 second
  const frequency = 440; // A4 note

  const numSamples = Math.floor(duration * sampleRate);
  const audioData = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    audioData[i] = Math.sin(2 * Math.PI * frequency * t);
  }

  // Configure CQT for musical analysis
  const config: CQTConfig = {
    sampleRate: 44100,
    fmin: 32.7, // C1 (~lowest note on piano)
    fmax: 4186, // C8 (~highest note on piano)
    binsPerOctave: 12, // Semitone resolution (12 bins per octave)
    hopLength: 512, // ~11.6ms per frame at 44.1kHz
  };

  console.log("Computing CQT...");
  const result = await computeCQT(audioData, config);

  console.log(`Results:`);
  console.log(`  - Number of frequency bins: ${result.numBins}`);
  console.log(`  - Number of time frames: ${result.numFrames}`);
  console.log(`  - Frequency range: ${result.frequencies[0].toFixed(2)} Hz to ${result.frequencies[result.numBins - 1].toFixed(2)} Hz`);
  console.log(`  - Time range: ${result.timeStart.toFixed(3)}s to ${result.timeEnd.toFixed(3)}s`);
  console.log(`  - Time resolution: ${(result.timeStep * 1000).toFixed(2)}ms per frame\n`);

  // Find the strongest frequency
  let maxBin = 0;
  let maxEnergy = 0;

  for (let bin = 0; bin < result.numBins; bin++) {
    let binEnergy = 0;
    for (let frame = 0; frame < result.numFrames; frame++) {
      const magnitude = result.magnitudes[frame * result.numBins + bin];
      binEnergy += magnitude * magnitude;
    }
    if (binEnergy > maxEnergy) {
      maxEnergy = binEnergy;
      maxBin = bin;
    }
  }

  console.log(`Detected peak at bin ${maxBin}: ${result.frequencies[maxBin].toFixed(2)} Hz`);
  console.log(`(Input frequency was ${frequency} Hz)\n`);

  // Access magnitude data
  // Data is stored in column-major order: magnitudes[frame * numBins + bin]
  const frame = Math.floor(result.numFrames / 2); // Middle of the audio
  const bin = maxBin;
  const magnitude = result.magnitudes[frame * result.numBins + bin];
  console.log(`Magnitude at frame ${frame}, bin ${bin}: ${magnitude.toFixed(4)}`);
}

// Example 2: High-resolution frequency analysis
async function highResolutionExample() {
  console.log("\n=== High-Resolution CQT Example ===\n");

  // Generate a chord (C major: C4 + E4 + G4)
  const sampleRate = 44100;
  const duration = 1.0;
  const numSamples = Math.floor(duration * sampleRate);
  const audioData = new Float32Array(numSamples);

  const notes = [261.63, 329.63, 392.0]; // C4, E4, G4 in Hz

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;
    for (const freq of notes) {
      sample += Math.sin(2 * Math.PI * freq * t) / notes.length;
    }
    audioData[i] = sample;
  }

  // High-resolution config
  const config: CQTConfig = {
    sampleRate: 44100,
    fmin: 200,
    fmax: 500,
    binsPerOctave: 36, // 3 bins per semitone for very high resolution
    hopLength: 256, // Higher time resolution
  };

  console.log("Computing high-resolution CQT...");
  const result = await computeCQT(audioData, config);

  console.log(`Results:`);
  console.log(`  - Number of bins: ${result.numBins}`);
  console.log(`  - Number of frames: ${result.numFrames}`);
  console.log(`  - Frequency resolution: ${((result.frequencies[1] - result.frequencies[0])).toFixed(3)} Hz per bin\n`);

  // Find top 3 peaks
  const binEnergies = new Float32Array(result.numBins);
  for (let bin = 0; bin < result.numBins; bin++) {
    for (let frame = 0; frame < result.numFrames; frame++) {
      const magnitude = result.magnitudes[frame * result.numBins + bin];
      binEnergies[bin] += magnitude * magnitude;
    }
  }

  const peaks = Array.from(binEnergies)
    .map((energy, bin) => ({ bin, energy, freq: result.frequencies[bin] }))
    .sort((a, b) => b.energy - a.energy)
    .slice(0, 3);

  console.log("Top 3 detected frequencies:");
  for (let i = 0; i < peaks.length; i++) {
    console.log(`  ${i + 1}. ${peaks[i].freq.toFixed(2)} Hz (bin ${peaks[i].bin})`);
  }
  console.log(`\nInput chord: ${notes.join(", ")} Hz\n`);
}

// Example 3: Converting to dB scale
async function dBScaleExample() {
  console.log("=== dB Scale Conversion Example ===\n");

  // Generate audio with varying amplitude
  const sampleRate = 44100;
  const duration = 0.5;
  const numSamples = Math.floor(duration * sampleRate);
  const audioData = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = Math.exp(-t * 3); // Exponential decay
    audioData[i] = envelope * Math.sin(2 * Math.PI * 440 * t);
  }

  const config: CQTConfig = {
    sampleRate: 44100,
    fmin: 400,
    fmax: 500,
    binsPerOctave: 12,
    hopLength: 256,
  };

  const result = await computeCQT(audioData, config);

  // Convert to dB scale
  const magnitudesDB = magnitudesToDB(result.magnitudes, 1.0, -80);

  // Find the bin corresponding to 440 Hz
  let targetBin = 0;
  let minDiff = Infinity;
  for (let bin = 0; bin < result.numBins; bin++) {
    const diff = Math.abs(result.frequencies[bin] - 440);
    if (diff < minDiff) {
      minDiff = diff;
      targetBin = bin;
    }
  }

  console.log(`Analyzing 440 Hz bin (bin ${targetBin}, actual freq: ${result.frequencies[targetBin].toFixed(2)} Hz)`);
  console.log("\nMagnitude decay over time:");
  console.log("Frame | Time (s) | Linear Mag | dB");
  console.log("------|----------|------------|-------");

  for (let frame = 0; frame < Math.min(10, result.numFrames); frame += 2) {
    const time = frame * result.timeStep;
    const linearMag = result.magnitudes[frame * result.numBins + targetBin];
    const dbMag = magnitudesDB[frame * result.numBins + targetBin];
    console.log(
      `${frame.toString().padStart(5)} | ${time.toFixed(4)}   | ${linearMag.toFixed(6)}   | ${dbMag.toFixed(2)}`
    );
  }
}

// Run all examples
if (import.meta.main) {
  await basicExample();
  await highResolutionExample();
  await dBScaleExample();
}
