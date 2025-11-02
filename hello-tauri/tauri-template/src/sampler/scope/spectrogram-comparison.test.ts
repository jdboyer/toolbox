/**
 * Comprehensive Spectrogram Comparison Test
 *
 * This test generates a 3-second audio signal and compares the complete spectrogram
 * output from two methods:
 * 1. Reference CQT implementation (CPU-based)
 * 2. GPU Analyzer pipeline
 *
 * The outputs should match EXACTLY. This test suspects every part of the pipeline.
 */

import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.214.0/assert/mod.ts";

// Import reference CQT implementation
const cqtModule = await import("../cqt/cqt.ts");
const computeCQT = cqtModule.computeCQT;

// Import GPU Analyzer
const analyzerModule = await import("./analyzer.ts");
const Analyzer = analyzerModule.Analyzer;

// Import WaveletTransform to verify parameters
const waveletModule = await import("./wavelet-transform.ts");
const WaveletTransform = waveletModule.WaveletTransform;

// Test configuration matching the actual app
// CRITICAL: Must match EXACTLY transformer.ts:99-105
const TEST_CONFIG = {
  fmin: 32.7, // C1 - must match transformer.ts:101 exactly!
  fmax: 16000,
  binsPerOctave: 12,
  sampleRate: 48000,
  hopLength: 256, // Fixed hop length to match reference CQT
  inputBufferSize: 65536,
  timeSliceCount: 128,
};

/**
 * Generate a complex 3-second test signal with multiple frequency components
 * This makes it easier to verify the spectrogram is computed correctly
 */
function generateTestSignal(durationSeconds: number, sampleRate: number): Float32Array {
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const samples = new Float32Array(numSamples);

  // Frequency components with different amplitudes and phases
  // These should show up clearly in the spectrogram
  const components = [
    { freq: 100, amp: 0.3, phase: 0 },      // Low frequency
    { freq: 440, amp: 0.5, phase: 0 },      // A4 (middle)
    { freq: 1000, amp: 0.4, phase: Math.PI/4 },  // High-mid
    { freq: 2000, amp: 0.2, phase: Math.PI/2 },  // High
  ];

  for (let i = 0; i < numSamples; i++) {
    let value = 0;
    for (const { freq, amp, phase } of components) {
      value += amp * Math.sin(2 * Math.PI * freq * i / sampleRate + phase);
    }
    samples[i] = value / components.length; // Normalize
  }

  return samples;
}

/**
 * Read transform output from GPU buffer, removing padding
 */
async function readTransformOutput(
  device: GPUDevice,
  buffer: GPUBuffer,
  numBins: number,
  numFrames: number
): Promise<Float32Array> {
  // Calculate padded dimensions
  const bytesPerRow = Math.ceil((numBins * 4) / 256) * 256;
  const floatsPerRow = bytesPerRow / 4;

  // Create staging buffer
  const stagingBuffer = device.createBuffer({
    size: bytesPerRow * numFrames,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  // Copy from GPU buffer to staging buffer
  const commandEncoder = device.createCommandEncoder();
  commandEncoder.copyBufferToBuffer(
    buffer,
    0,
    stagingBuffer,
    0,
    bytesPerRow * numFrames
  );
  device.queue.submit([commandEncoder.finish()]);

  // Map and read
  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const paddedData = new Float32Array(stagingBuffer.getMappedRange());

  // Remove padding
  const unpaddedData = new Float32Array(numBins * numFrames);
  for (let frame = 0; frame < numFrames; frame++) {
    for (let bin = 0; bin < numBins; bin++) {
      unpaddedData[frame * numBins + bin] = paddedData[frame * floatsPerRow + bin];
    }
  }

  stagingBuffer.unmap();
  stagingBuffer.destroy();

  return unpaddedData;
}

/**
 * Calculate expected number of frames using CQT formula
 */
function calculateExpectedFrames(audioLength: number, maxKernelLength: number, hopLength: number): number {
  return Math.floor((audioLength - maxKernelLength) / hopLength) + 1;
}

/**
 * Compare two spectrograms value by value
 */
function compareSpectrograms(
  reference: Float32Array,
  test: Float32Array,
  numBins: number,
  numFrames: number,
  tolerance: number = 0.0001
): { matches: boolean; details: string } {
  if (reference.length !== test.length) {
    return {
      matches: false,
      details: `Length mismatch: reference=${reference.length}, test=${test.length}`
    };
  }

  let totalDiff = 0;
  let maxDiff = 0;
  let mismatchCount = 0;
  let totalValues = 0;

  const mismatches: Array<{frame: number, bin: number, ref: number, test: number, diff: number}> = [];

  for (let frame = 0; frame < numFrames; frame++) {
    for (let bin = 0; bin < numBins; bin++) {
      const idx = frame * numBins + bin;
      const refVal = reference[idx];
      const testVal = test[idx];
      const diff = Math.abs(refVal - testVal);

      totalDiff += diff;
      maxDiff = Math.max(maxDiff, diff);
      totalValues++;

      if (diff > tolerance) {
        mismatchCount++;
        if (mismatches.length < 10) { // Keep first 10 mismatches
          mismatches.push({ frame, bin, ref: refVal, test: testVal, diff });
        }
      }
    }
  }

  const avgDiff = totalDiff / totalValues;
  const mismatchPercent = (mismatchCount / totalValues) * 100;

  let details = `Statistics:\n`;
  details += `  Total values: ${totalValues}\n`;
  details += `  Mismatches (>${tolerance}): ${mismatchCount} (${mismatchPercent.toFixed(2)}%)\n`;
  details += `  Average diff: ${avgDiff.toExponential(4)}\n`;
  details += `  Max diff: ${maxDiff.toExponential(4)}\n`;

  if (mismatches.length > 0) {
    details += `\nFirst ${Math.min(10, mismatches.length)} mismatches:\n`;
    for (const m of mismatches) {
      details += `  Frame ${m.frame}, Bin ${m.bin}: ref=${m.ref.toExponential(4)}, test=${m.test.toExponential(4)}, diff=${m.diff.toExponential(4)}\n`;
    }
  }

  return {
    matches: mismatchCount === 0,
    details
  };
}

Deno.test("3-second spectrogram: Reference CQT vs GPU Analyzer - exact match", async () => {
  console.log("\n========================================");
  console.log("Spectrogram Comparison Test");
  console.log("========================================\n");

  // Step 1: Initialize WebGPU
  console.log("Step 1: Initializing WebGPU...");
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    throw new Error("WebGPU not supported");
  }
  const device = await adapter.requestDevice();
  console.log("  ✓ WebGPU initialized");

  // Step 2: Generate test signal (use shorter duration to fit in one buffer)
  console.log("\nStep 2: Generating test signal...");
  // Use 57,344 samples (matches Sampler.tsx's 1.2s * 48000 rounded to 4096 boundary)
  // This fits in the 65,536 input buffer size
  const durationSeconds = 57344 / TEST_CONFIG.sampleRate;
  const samples = generateTestSignal(durationSeconds, TEST_CONFIG.sampleRate);
  console.log(`  ✓ Generated ${samples.length} samples (${durationSeconds.toFixed(2)}s at ${TEST_CONFIG.sampleRate} Hz)`);

  // Step 3: Initialize WaveletTransform to get parameters
  console.log("\nStep 3: Initializing WaveletTransform...");
  const waveletTransform = new WaveletTransform(device, TEST_CONFIG);
  const numBins = waveletTransform.getNumBins();
  const maxKernelLength = waveletTransform.getMaxKernelLength();
  const hopLength = 256; // Must be fixed at 256

  console.log(`  Frequency bins: ${numBins}`);
  console.log(`  Max kernel length: ${maxKernelLength} samples`);
  console.log(`  Hop length: ${hopLength} samples`);

  // Step 3.5: Compare kernel parameters
  console.log("\nStep 3a: Comparing kernel generation...");
  const waveletKernel = waveletTransform["kernel"];
  console.log(`  Wavelet kernel bins: ${waveletKernel.numBins}`);
  console.log(`  Wavelet max kernel: ${waveletKernel.maxKernelLength}`);

  // Step 4: Calculate expected frames
  const expectedFrames = calculateExpectedFrames(samples.length, maxKernelLength, hopLength);
  console.log(`  Expected frames: ${expectedFrames}`);
  console.log(`  Formula: floor((${samples.length} - ${maxKernelLength}) / ${hopLength}) + 1 = ${expectedFrames}`);

  // Step 5: Compute reference CQT spectrogram
  console.log("\nStep 4: Computing reference CQT spectrogram...");
  // CRITICAL: Use EXACT same fmin as transformer (32.7, not 32.70319566257483)
  // Otherwise kernels will be different!
  const cqtConfig = {
    fmin: 32.7, // Must match transformer.ts:101
    fmax: TEST_CONFIG.fmax,
    binsPerOctave: TEST_CONFIG.binsPerOctave,
    sampleRate: TEST_CONFIG.sampleRate,
    hopLength: hopLength,
  };

  const cqtResult = await computeCQT(samples, cqtConfig, device);
  console.log(`  ✓ CQT computed: ${cqtResult.numBins} bins × ${cqtResult.numFrames} frames`);
  console.log(`  Data length: ${cqtResult.magnitudes.length} values`);
  console.log(`  Value range: [${Math.min(...cqtResult.magnitudes).toExponential(4)}, ${Math.max(...cqtResult.magnitudes).toExponential(4)}]`);

  const cqtNonZero = Array.from(cqtResult.magnitudes).filter(v => v > 0.0001).length;
  console.log(`  Non-zero values (>0.0001): ${cqtNonZero} (${(cqtNonZero/cqtResult.magnitudes.length*100).toFixed(1)}%)`);

  // Verify CQT dimensions
  assertEquals(cqtResult.numBins, numBins, "CQT bin count should match WaveletTransform");
  assertEquals(cqtResult.numFrames, expectedFrames, "CQT frame count should match formula");

  // Step 6: Compute GPU Analyzer spectrogram
  console.log("\nStep 5: Computing GPU Analyzer spectrogram...");
  const analyzer = new Analyzer(device, adapter);

  // Process samples through analyzer
  console.log("  Processing samples through analyzer...");
  let minSample = samples[0], maxSample = samples[0], sumSample = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] < minSample) minSample = samples[i];
    if (samples[i] > maxSample) maxSample = samples[i];
    sumSample += samples[i];
  }
  console.log(`  Sample stats: min=${minSample.toFixed(4)}, max=${maxSample.toFixed(4)}, avg=${(sumSample/samples.length).toFixed(4)}`);
  analyzer.processSamples(samples);

  // Check accumulator state
  const accumulator = analyzer.getAccumulator();
  console.log(`  Accumulator has processed samples`);

  // Get the transform output buffer
  const transformer = analyzer.getTransformer();
  const outputRing = transformer.getOutputBufferRing();

  // Read the most recent output buffer
  const writeIndex = outputRing.getWriteIndex();
  const lastBufferIndex = (writeIndex - 1 + outputRing.getCount()) % outputRing.getCount();
  console.log(`  Output ring write index: ${writeIndex}, reading buffer: ${lastBufferIndex}`);
  const transformBuffer = outputRing.getBuffer(lastBufferIndex);

  // Read the GPU output
  // Note: The analyzer always uses 128 frames (timeSliceCount) regardless of actual audio length
  const analyzerFrameCount = Math.min(expectedFrames, 128);
  console.log("  Reading GPU output buffer...");
  console.log(`  Note: Using ${analyzerFrameCount} frames (min of expected ${expectedFrames} and max 128)`);
  const analyzerData = await readTransformOutput(device, transformBuffer, numBins, analyzerFrameCount);
  console.log(`  ✓ Analyzer data read: ${analyzerData.length} values`);
  console.log(`  Value range: [${Math.min(...analyzerData).toExponential(4)}, ${Math.max(...analyzerData).toExponential(4)}]`);

  const analyzerNonZero = Array.from(analyzerData).filter(v => v > 0.0001).length;
  console.log(`  Non-zero values (>0.0001): ${analyzerNonZero} (${(analyzerNonZero/analyzerData.length*100).toFixed(1)}%)`);

  // Step 7: Verify dimensions match
  console.log("\nStep 6: Verifying dimensions...");

  // Extract only the first analyzerFrameCount frames from CQT for comparison
  const cqtDataToCompare = new Float32Array(numBins * analyzerFrameCount);
  for (let frame = 0; frame < analyzerFrameCount; frame++) {
    for (let bin = 0; bin < numBins; bin++) {
      cqtDataToCompare[frame * numBins + bin] = cqtResult.magnitudes[frame * numBins + bin];
    }
  }

  console.log(`  Comparing first ${analyzerFrameCount} frames only`);
  console.log(`  CQT data to compare: ${cqtDataToCompare.length} values`);
  console.log(`  Analyzer data: ${analyzerData.length} values`);

  assertEquals(analyzerData.length, cqtDataToCompare.length,
    `Analyzer data length should match CQT subset (${analyzerData.length} vs ${cqtDataToCompare.length})`);

  const expectedLength = numBins * analyzerFrameCount;
  assertEquals(analyzerData.length, expectedLength,
    `Data length should be ${numBins} bins × ${analyzerFrameCount} frames = ${expectedLength}`);
  console.log(`  ✓ Dimensions match: ${numBins} bins × ${analyzerFrameCount} frames = ${expectedLength} values`);

  // Step 7.5: Diagnostic - Check if data might be transposed
  console.log("\nStep 7a: Checking for data transposition...");

  // Try transposing analyzer data (bin×frame -> frame×bin)
  const transposedAnalyzerData = new Float32Array(numBins * analyzerFrameCount);
  for (let frame = 0; frame < analyzerFrameCount; frame++) {
    for (let bin = 0; bin < numBins; bin++) {
      // Read as bin-major, write as frame-major
      transposedAnalyzerData[frame * numBins + bin] = analyzerData[bin * analyzerFrameCount + frame];
    }
  }

  const transposedComparison = compareSpectrograms(cqtDataToCompare, transposedAnalyzerData, numBins, analyzerFrameCount, 0.0001);
  console.log(`  Transposed match rate: ${100 - (transposedComparison.details.match(/Mismatches.*?(\d+\.\d+)%/)?.[1] || 100)}%`);

  // Step 7.75: Check first frame separately
  console.log("\nStep 7b: Checking Frame 0 separately...");
  let frame0Matches = 0;
  for (let bin = 0; bin < numBins; bin++) {
    const refVal = cqtDataToCompare[bin];
    const testVal = analyzerData[bin];
    const diff = Math.abs(refVal - testVal);
    if (diff <= 0.0001) frame0Matches++;
  }
  console.log(`  Frame 0 matches: ${frame0Matches}/${numBins} bins (${(frame0Matches/numBins*100).toFixed(1)}%)`);

  // Step 8: Compare spectrograms value by value
  console.log("\nStep 7c: Comparing spectrograms value by value (original layout)...");
  const comparison = compareSpectrograms(cqtDataToCompare, analyzerData, numBins, analyzerFrameCount, 0.0001);

  console.log("\n" + comparison.details);

  // If transposed is better, use that
  if (!comparison.matches && transposedComparison.matches) {
    console.log("\n⚠️ DATA IS TRANSPOSED! Using transposed data for comparison.");
    console.log("\n" + transposedComparison.details);
  }

  // Step 9: Assert exact match
  console.log("\nStep 8: Final verification...");
  if (!comparison.matches) {
    console.log("  ✗ SPECTROGRAMS DO NOT MATCH!");
    console.log("\nDiagnostic Information:");
    console.log("  This indicates a discrepancy in one of these pipeline stages:");
    console.log("    1. Sample accumulation (accumulator)");
    console.log("    2. Frame calculation (transformer)");
    console.log("    3. Wavelet transform parameters (WaveletTransform)");
    console.log("    4. GPU kernel computation (wavelet-transform.wgsl)");
    console.log("    5. Buffer padding/alignment (readTransformOutput)");
    throw new Error("Spectrograms do not match exactly. See details above.");
  }

  console.log("  ✓ SPECTROGRAMS MATCH EXACTLY!");
  console.log("\nAll pipeline stages verified:");
  console.log("  ✓ Sample accumulation");
  console.log("  ✓ Frame calculation");
  console.log("  ✓ Wavelet transform parameters");
  console.log("  ✓ GPU kernel computation");
  console.log("  ✓ Buffer padding/alignment");

  console.log("\n========================================");
  console.log("Test PASSED");
  console.log("========================================\n");
});
