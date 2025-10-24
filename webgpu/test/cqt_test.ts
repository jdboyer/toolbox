/**
 * Test suite for WebGPU CQT implementation
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeCQT, magnitudesToDB, type CQTConfig } from "../cqt.ts";
import { generateTestWav, parseWav, stereoToMono } from "./wav_reader.ts";
import { savePNG, saveRawBinary } from "./png_writer.ts";

/**
 * Test basic CQT computation with a sine wave
 */
Deno.test("CQT - Sine wave test", async () => {
  // Generate test audio: 440 Hz sine wave (A4 note)
  const sampleRate = 44100;
  const duration = 2.0; // seconds
  const frequency = 440; // Hz

  console.log(`Generating test sine wave: ${frequency} Hz, ${duration}s`);

  const wavData = generateTestWav(frequency, duration, sampleRate);
  const parsed = parseWav(wavData);
  const monoAudio = stereoToMono(parsed.audioData, parsed.numChannels);

  console.log(`Audio length: ${monoAudio.length} samples`);

  // Configure CQT
  const config: CQTConfig = {
    sampleRate,
    fmin: 32.7, // C1
    fmax: 8000, // Just below Nyquist/2 for safety
    binsPerOctave: 12, // Semitone resolution
    hopLength: 512,
  };

  console.log("Computing CQT...");
  const result = await computeCQT(monoAudio, config);

  console.log(`CQT Result:`);
  console.log(`  - Bins: ${result.numBins}`);
  console.log(`  - Frames: ${result.numFrames}`);
  console.log(`  - Frequency range: ${result.frequencies[0].toFixed(2)} Hz to ${result.frequencies[result.numBins - 1].toFixed(2)} Hz`);
  console.log(`  - Time range: ${result.timeStart.toFixed(3)}s to ${result.timeEnd.toFixed(3)}s`);
  console.log(`  - Time step: ${result.timeStep.toFixed(4)}s`);

  // Verify result structure
  assertExists(result.magnitudes);
  assertEquals(result.magnitudes.length, result.numBins * result.numFrames);
  assertEquals(result.frequencies.length, result.numBins);

  // Find the bin with maximum energy (should be around 440 Hz)
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

  const detectedFreq = result.frequencies[maxBin];
  console.log(`Detected peak frequency: ${detectedFreq.toFixed(2)} Hz (bin ${maxBin})`);

  // The detected frequency should be close to 440 Hz
  // Allow some tolerance due to logarithmic frequency bins
  const tolerance = 440 * 0.1; // 10% tolerance
  assertEquals(
    Math.abs(detectedFreq - frequency) < tolerance,
    true,
    `Expected frequency around ${frequency} Hz, got ${detectedFreq.toFixed(2)} Hz`
  );

  // Convert to dB scale for visualization
  const magnitudesDB = magnitudesToDB(result.magnitudes, 1.0, -80);

  // Save as PNG (transpose to have time on x-axis, frequency on y-axis)
  console.log("Saving CQT as PNG...");
  const transposed = new Float32Array(result.numBins * result.numFrames);
  for (let bin = 0; bin < result.numBins; bin++) {
    for (let frame = 0; frame < result.numFrames; frame++) {
      // Flip vertically so low frequencies are at bottom
      const srcBin = result.numBins - 1 - bin;
      transposed[bin * result.numFrames + frame] = magnitudesDB[frame * result.numBins + srcBin];
    }
  }

  await savePNG(
    transposed,
    result.numFrames, // width (time)
    result.numBins,   // height (frequency)
    "test/output_sine_wave.png",
    true // normalize
  );

  // Save raw binary format
  console.log("Saving CQT as raw binary...");
  await saveRawBinary(
    result.magnitudes,
    result.numFrames,
    result.numBins,
    "test/output_sine_wave.cqt"
  );

  console.log("Test completed successfully!");
});

/**
 * Test CQT with a chirp signal (frequency sweep)
 */
Deno.test("CQT - Chirp test", async () => {
  const sampleRate = 44100;
  const duration = 2.0;
  const startFreq = 100;
  const endFreq = 2000;

  console.log(`Generating chirp: ${startFreq} Hz to ${endFreq} Hz`);

  // Generate chirp manually
  const numSamples = Math.floor(duration * sampleRate);
  const audioData = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (startFreq * t + (endFreq - startFreq) * t * t / (2 * duration));
    audioData[i] = Math.sin(phase);
  }

  // Configure CQT
  const config: CQTConfig = {
    sampleRate,
    fmin: 50,
    fmax: 4000,
    binsPerOctave: 24, // Higher resolution
    hopLength: 256,
  };

  console.log("Computing CQT for chirp...");
  const result = await computeCQT(audioData, config);

  console.log(`CQT Result:`);
  console.log(`  - Bins: ${result.numBins}`);
  console.log(`  - Frames: ${result.numFrames}`);

  // Convert to dB and save
  const magnitudesDB = magnitudesToDB(result.magnitudes, 1.0, -80);

  // Transpose and flip
  const transposed = new Float32Array(result.numBins * result.numFrames);
  for (let bin = 0; bin < result.numBins; bin++) {
    for (let frame = 0; frame < result.numFrames; frame++) {
      const srcBin = result.numBins - 1 - bin;
      transposed[bin * result.numFrames + frame] = magnitudesDB[frame * result.numBins + srcBin];
    }
  }

  await savePNG(
    transposed,
    result.numFrames,
    result.numBins,
    "test/output_chirp.png",
    true
  );

  console.log("Chirp test completed!");
});

/**
 * Test CQT with custom WAV file if it exists
 */
Deno.test("CQT - Custom WAV file test", async () => {
  const wavPath = "test/test_audio.wav";

  // Check if custom test file exists
  try {
    await Deno.stat(wavPath);
  } catch {
    console.log(`Skipping custom WAV test: ${wavPath} not found`);
    return;
  }

  console.log(`Loading WAV file: ${wavPath}`);

  const { readWavFile } = await import("./wav_reader.ts");
  const wavData = await readWavFile(wavPath);

  console.log(`WAV Info:`);
  console.log(`  - Sample rate: ${wavData.sampleRate} Hz`);
  console.log(`  - Channels: ${wavData.numChannels}`);
  console.log(`  - Bits per sample: ${wavData.bitsPerSample}`);
  console.log(`  - Duration: ${(wavData.audioData.length / wavData.numChannels / wavData.sampleRate).toFixed(2)}s`);

  // Convert to mono
  const monoAudio = stereoToMono(wavData.audioData, wavData.numChannels);

  // Check audio statistics
  let minAudio = Infinity;
  let maxAudio = -Infinity;
  let rms = 0;
  for (let i = 0; i < monoAudio.length; i++) {
    minAudio = Math.min(minAudio, monoAudio[i]);
    maxAudio = Math.max(maxAudio, monoAudio[i]);
    rms += monoAudio[i] * monoAudio[i];
  }
  rms = Math.sqrt(rms / monoAudio.length);

  console.log(`Audio stats:`);
  console.log(`  - Range: ${minAudio.toFixed(6)} to ${maxAudio.toFixed(6)}`);
  console.log(`  - RMS: ${rms.toFixed(6)}`);
  console.log(`  - Samples: ${monoAudio.length}`);

  // Configure CQT for musical analysis
  // Adjust fmin based on sample rate to keep kernel sizes reasonable
  // At higher sample rates, very low frequencies create massive kernels
  const fmin = wavData.sampleRate >= 44100 ? 55 : 32.7; // A1 for high sample rates, C1 otherwise

  const config: CQTConfig = {
    sampleRate: wavData.sampleRate,
    fmin: fmin,
    fmax: Math.min(8000, wavData.sampleRate / 2), // Limit to reasonable range
    binsPerOctave: 24, // 2 bins per semitone for good resolution
    hopLength: 512,
  };

  console.log("Computing CQT...");
  const result = await computeCQT(monoAudio, config);

  console.log(`CQT Result:`);
  console.log(`  - Bins: ${result.numBins}`);
  console.log(`  - Frames: ${result.numFrames}`);
  console.log(`  - Frequency range: ${result.frequencies[0].toFixed(2)} Hz to ${result.frequencies[result.numBins - 1].toFixed(2)} Hz`);

  // Check magnitude statistics
  let minMag = Infinity;
  let maxMag = -Infinity;
  let avgMag = 0;
  for (let i = 0; i < result.magnitudes.length; i++) {
    const mag = result.magnitudes[i];
    minMag = Math.min(minMag, mag);
    maxMag = Math.max(maxMag, mag);
    avgMag += mag;
  }
  avgMag /= result.magnitudes.length;

  console.log(`  - Magnitude range: ${minMag.toFixed(6)} to ${maxMag.toFixed(6)} (avg: ${avgMag.toFixed(6)})`);

  // Convert to dB and save
  const magnitudesDB = magnitudesToDB(result.magnitudes, 1.0, -80);

  // Check dB statistics
  let minDB = Infinity;
  let maxDB = -Infinity;
  for (let i = 0; i < magnitudesDB.length; i++) {
    minDB = Math.min(minDB, magnitudesDB[i]);
    maxDB = Math.max(maxDB, magnitudesDB[i]);
  }
  console.log(`  - dB range: ${minDB.toFixed(2)} to ${maxDB.toFixed(2)}`);

  // Transpose and flip
  const transposed = new Float32Array(result.numBins * result.numFrames);
  for (let bin = 0; bin < result.numBins; bin++) {
    for (let frame = 0; frame < result.numFrames; frame++) {
      const srcBin = result.numBins - 1 - bin;
      transposed[bin * result.numFrames + frame] = magnitudesDB[frame * result.numBins + srcBin];
    }
  }

  await savePNG(
    transposed,
    result.numFrames,
    result.numBins,
    "test/output_custom.png",
    true // This will normalize the dB values to [0, 255]
  );

  await saveRawBinary(
    result.magnitudes,
    result.numFrames,
    result.numBins,
    "test/output_custom.cqt"
  );

  console.log("Custom WAV test completed!");
});
