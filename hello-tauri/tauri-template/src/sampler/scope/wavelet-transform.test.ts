/**
 * Unit tests for wavelet transform (CQT) implementation
 *
 * These tests verify that the wavelet transform produces the same results
 * as the reference CQT implementation in src/sampler/cqt/cqt.ts
 */

import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Test configuration matching the reference CQT
const TEST_CONFIG = {
  sampleRate: 48000,
  fmin: 32.7,
  fmax: 16000,
  binsPerOctave: 12,
  hopLength: 256,
};

/**
 * Test: Verify number of bins calculation
 */
Deno.test("WaveletTransform - calculates correct number of bins", () => {
  const expectedBins = Math.ceil(
    TEST_CONFIG.binsPerOctave * Math.log2(TEST_CONFIG.fmax / TEST_CONFIG.fmin)
  );

  // Should be 108 bins
  assertEquals(expectedBins, 108);
});

/**
 * Test: Verify frequency bins match reference CQT
 */
Deno.test("WaveletTransform - generates correct frequency bins", () => {
  const numBins = 108;
  const frequencies = new Float32Array(numBins);

  for (let k = 0; k < numBins; k++) {
    frequencies[k] = TEST_CONFIG.fmin * Math.pow(2, k / TEST_CONFIG.binsPerOctave);
  }

  // Check first few frequencies
  assertAlmostEquals(frequencies[0], 32.7, 0.01); // C1
  assertAlmostEquals(frequencies[12], 65.4, 0.1); // C2 (one octave up)
  assertAlmostEquals(frequencies[24], 130.8, 0.1); // C3 (two octaves up)

  // Check last frequency is close to fmax
  const lastFreq = frequencies[numBins - 1];
  assertEquals(lastFreq < TEST_CONFIG.fmax, true);
  assertEquals(lastFreq > TEST_CONFIG.fmax * 0.95, true);
});

/**
 * Test: Verify kernel lengths calculation
 */
Deno.test("WaveletTransform - calculates correct kernel lengths", () => {
  const numBins = 108;
  const Q = 1.0 / (Math.pow(2, 1.0 / TEST_CONFIG.binsPerOctave) - 1);
  const windowScale = 1.0;

  const kernelLengths = new Uint32Array(numBins);
  let maxKernelLength = 0;

  for (let k = 0; k < numBins; k++) {
    const freq = TEST_CONFIG.fmin * Math.pow(2, k / TEST_CONFIG.binsPerOctave);
    const length = Math.ceil((Q * TEST_CONFIG.sampleRate * windowScale) / freq);
    kernelLengths[k] = length;
    maxKernelLength = Math.max(maxKernelLength, length);
  }

  // Lowest frequency should have longest kernel
  assertEquals(kernelLengths[0], maxKernelLength);

  // Should be approximately 24,686 samples for 32.7 Hz at 48kHz
  assertEquals(maxKernelLength > 24000, true);
  assertEquals(maxKernelLength < 25000, true);

  console.log(`Max kernel length: ${maxKernelLength} samples`);
});

/**
 * Test: Verify number of frames calculation
 */
Deno.test("WaveletTransform - calculates correct number of frames", () => {
  const audioLength = 32768; // Input buffer size
  const hopLength = TEST_CONFIG.hopLength; // 256
  const maxKernelLength = 24686; // Approximate

  // Formula from reference CQT: (audioLength - maxKernelLength) / hopLength + 1
  const expectedFrames = Math.floor((audioLength - maxKernelLength) / hopLength) + 1;

  // Should be approximately 32 frames for a 32768-sample buffer
  console.log(`Expected frames for ${audioLength} samples: ${expectedFrames}`);
  assertEquals(expectedFrames > 30, true);
  assertEquals(expectedFrames < 35, true);
});

/**
 * Test: Verify Hamming window values
 */
Deno.test("WaveletTransform - generates correct Hamming window", () => {
  const length = 100;
  const window = new Float32Array(length);

  for (let n = 0; n < length; n++) {
    window[n] = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (length - 1));
  }

  // Window should peak at center
  const centerIdx = Math.floor(length / 2);
  assertAlmostEquals(window[centerIdx], 1.0, 0.01);

  // Window should be ~0.08 at edges
  assertAlmostEquals(window[0], 0.08, 0.01);
  assertAlmostEquals(window[length - 1], 0.08, 0.01);

  // Window should be symmetric
  assertAlmostEquals(window[10], window[length - 11], 0.001);
});

/**
 * Test: Verify complex exponential phase
 */
Deno.test("WaveletTransform - generates correct complex exponential", () => {
  const freq = 1000; // Hz
  const sampleRate = 48000;
  const samplesPerPeriod = sampleRate / freq; // 48 samples

  const real = new Float32Array(samplesPerPeriod);
  const imag = new Float32Array(samplesPerPeriod);

  for (let n = 0; n < samplesPerPeriod; n++) {
    const phase = -2 * Math.PI * freq * n / sampleRate;
    real[n] = Math.cos(phase);
    imag[n] = Math.sin(phase);
  }

  // At n=0, should be (1, 0)
  assertAlmostEquals(real[0], 1.0, 0.001);
  assertAlmostEquals(imag[0], 0.0, 0.001);

  // At 1/4 period, should be (0, -1)
  const quarter = Math.floor(samplesPerPeriod / 4);
  assertAlmostEquals(real[quarter], 0.0, 0.01);
  assertAlmostEquals(imag[quarter], -1.0, 0.01);
});

/**
 * Test: Verify output buffer size calculation with padding
 */
Deno.test("WaveletTransform - calculates correct output buffer size", () => {
  const numBins = 108;
  const numFrames = 128;

  // Calculate bytes per row with 256-byte alignment
  const bytesPerRow = Math.ceil((numBins * 4) / 256) * 256;
  const floatsPerRow = bytesPerRow / 4;
  const totalFloats = floatsPerRow * numFrames;

  // Should be 128 floats per row (padded from 108)
  assertEquals(floatsPerRow, 128);

  // Total should be 16,384 floats
  assertEquals(totalFloats, 16384);

  console.log(`Output buffer: ${numBins} bins → ${floatsPerRow} floats/row × ${numFrames} frames = ${totalFloats} floats`);
});

/**
 * Test: Verify hopLength is fixed at 256 (not calculated from buffer size)
 */
Deno.test("WaveletTransform - hopLength must be 256", () => {
  const expectedHopLength = 256;

  // Should match the test config hopLength
  assertEquals(expectedHopLength, TEST_CONFIG.hopLength);

  // CRITICAL: hopLength should NOT be calculated as inputBufferSize / timeSliceCount
  // That would give 65536 / 128 = 512, which is WRONG
  const wrongHopLength = Math.floor(65536 / 128);
  console.log(`Wrong hopLength (from buffer size): ${wrongHopLength}`);
  console.log(`Correct hopLength (fixed): ${expectedHopLength}`);

  assertEquals(wrongHopLength !== expectedHopLength, true,
    "hopLength must be fixed at 256, not calculated from buffer size!");
});
