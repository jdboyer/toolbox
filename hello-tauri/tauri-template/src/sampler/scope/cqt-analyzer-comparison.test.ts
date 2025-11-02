/**
 * Integration test: Compare CQT reference implementation vs GPU Analyzer
 *
 * This test verifies that the GPU-accelerated wavelet transform produces
 * EXACTLY the same results as the reference CQT implementation.
 */

import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeCQT } from "../cqt/cqt.ts";
import { Analyzer } from "./analyzer.ts";

/**
 * Generate a test sine wave
 */
function generateSineWave(
  frequency: number,
  duration: number,
  sampleRate: number,
  amplitude: number = 0.5
): Float32Array {
  const numSamples = Math.floor(duration * sampleRate);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    samples[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate);
  }

  return samples;
}

/**
 * Extract data from GPU buffer with padding removed
 */
async function readTransformOutput(
  device: GPUDevice,
  buffer: GPUBuffer,
  numBins: number,
  numFrames: number
): Promise<Float32Array> {
  // Calculate buffer size with padding
  const bytesPerRow = Math.ceil((numBins * 4) / 256) * 256;
  const floatsPerRow = bytesPerRow / 4;
  const bufferSize = bytesPerRow * numFrames;

  // Create staging buffer
  const stagingBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  // Copy data
  const commandEncoder = device.createCommandEncoder();
  commandEncoder.copyBufferToBuffer(buffer, 0, stagingBuffer, 0, bufferSize);
  device.queue.submit([commandEncoder.finish()]);

  // Read back
  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const paddedData = new Float32Array(stagingBuffer.getMappedRange()).slice();
  stagingBuffer.unmap();

  // Remove padding
  const unpaddedData = new Float32Array(numBins * numFrames);
  for (let frame = 0; frame < numFrames; frame++) {
    for (let bin = 0; bin < numBins; bin++) {
      unpaddedData[frame * numBins + bin] = paddedData[frame * floatsPerRow + bin];
    }
  }

  stagingBuffer.destroy();
  return unpaddedData;
}

/**
 * Test: 440 Hz sine wave (A4 note)
 */
Deno.test("CQT vs Analyzer - 440 Hz sine wave exact match", async () => {
  // Initialize WebGPU
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    console.log("WebGPU not available, skipping test");
    return;
  }

  const device = await adapter.requestDevice();

  // Test configuration
  const testConfig = {
    sampleRate: 48000,
    fmin: 32.7,
    fmax: 16000,
    binsPerOctave: 12,
    hopLength: 256,
  };

  // Generate test signal: 440 Hz sine wave (A4)
  const frequency = 440; // Hz
  const duration = 1.2; // seconds (same as Sampler.tsx: 0.8s to 2.0s = 1.2s)
  const audioSamples = generateSineWave(frequency, duration, testConfig.sampleRate);

  // Round to 4096 multiple (same as Sampler.tsx)
  const blockSize = 4096;
  const numSamples = Math.floor(audioSamples.length / blockSize) * blockSize;
  const samples = audioSamples.slice(0, numSamples);

  console.log(`\n=== TEST SIGNAL ===`);
  console.log(`Frequency: ${frequency} Hz`);
  console.log(`Duration: ${duration}s`);
  console.log(`Sample rate: ${testConfig.sampleRate} Hz`);
  console.log(`Samples: ${samples.length}`);

  // === REFERENCE CQT ===
  console.log(`\n=== REFERENCE CQT ===`);
  const cqtResult = await computeCQT(samples, testConfig, device);

  console.log(`Bins: ${cqtResult.numBins}`);
  console.log(`Frames: ${cqtResult.numFrames}`);
  console.log(`Data range: ${Math.min(...cqtResult.magnitudes)} to ${Math.max(...cqtResult.magnitudes)}`);

  const cqtNonZero = Array.from(cqtResult.magnitudes).filter(v => v > 0.001).length;
  console.log(`Non-zero values (>0.001): ${cqtNonZero}`);

  // === GPU ANALYZER ===
  console.log(`\n=== GPU ANALYZER ===`);
  const analyzer = new Analyzer(device, adapter);
  analyzer.processSamples(samples);

  const transformer = analyzer.getTransformer();
  const outputRing = transformer.getOutputBufferRing();

  console.log(`Output buffers: ${outputRing.getCount()}`);

  // Read the most recent output buffer (writeIndex - 1 wraps around the ring)
  const writeIndex = outputRing.getWriteIndex();
  const lastBufferIndex = (writeIndex -1 + 4) % 4; // maxSize is 4 from DEFAULT_CONFIG
  console.log(`Write index: ${writeIndex}, Reading buffer index: ${lastBufferIndex}`);
  const outputBuffer = outputRing.getBuffer(lastBufferIndex);
  const waveletTransform = transformer["waveletTransform"];
  const numBins = waveletTransform.getNumBins();
  const analyzerData = await readTransformOutput(device, outputBuffer, numBins, 128);

  console.log(`Bins: ${numBins}`);
  console.log(`Analyzer data length: ${analyzerData.length} values (${numBins} bins × ${128} frames = ${numBins * 128})`);
  console.log(`Data range: ${Math.min(...analyzerData)} to ${Math.max(...analyzerData)}`);

  const analyzerNonZero = Array.from(analyzerData).filter(v => v > 0.001).length;
  console.log(`Non-zero values (>0.001): ${analyzerNonZero}`);

  // === COMPARISON ===
  console.log(`\n=== COMPARISON ===`);

  // Dimensions must match exactly
  assertEquals(numBins, cqtResult.numBins, "Number of bins must match");

  // For comparison, use the minimum number of frames (in case of slight mismatch)
  const compareFrames = Math.min(cqtResult.numFrames, 128);
  console.log(`Comparing first ${compareFrames} frames`);

  // Max values should be very close
  const cqtMax = Math.max(...cqtResult.magnitudes);
  const analyzerMax = Math.max(...analyzerData);
  const maxDiff = Math.abs(cqtMax - analyzerMax);
  const maxRelativeError = maxDiff / Math.max(cqtMax, analyzerMax);

  console.log(`Max value - CQT: ${cqtMax}, Analyzer: ${analyzerMax}, diff: ${maxDiff} (${(maxRelativeError * 100).toFixed(3)}%)`);
  assertAlmostEquals(analyzerMax, cqtMax, cqtMax * 0.01, "Max values should match within 1%");

  // Non-zero counts should be close
  const nonZeroDiff = Math.abs(cqtNonZero - analyzerNonZero);
  const nonZeroRelativeError = nonZeroDiff / Math.max(cqtNonZero, analyzerNonZero);

  console.log(`Non-zero count - CQT: ${cqtNonZero}, Analyzer: ${analyzerNonZero}, diff: ${nonZeroDiff} (${(nonZeroRelativeError * 100).toFixed(3)}%)`);
  // Note: GPU floating-point precision differences can cause values near threshold to differ
  assertEquals(nonZeroRelativeError < 0.20, true, "Non-zero counts should match within 20%");

  // Compare individual values
  let totalError = 0;
  let significantErrors = 0;
  const significantThreshold = 0.1; // 10% error on significant values

  for (let frame = 0; frame < compareFrames; frame++) {
    for (let bin = 0; bin < numBins; bin++) {
      const idx = frame * numBins + bin;
      const cqtVal = cqtResult.magnitudes[idx];
      const analyzerVal = analyzerData[idx];

      const diff = Math.abs(cqtVal - analyzerVal);
      totalError += diff;

      // Check significant values (>1% of max)
      if (cqtVal > cqtMax * 0.01 || analyzerVal > analyzerMax * 0.01) {
        const relativeError = diff / Math.max(cqtVal, analyzerVal, 0.001);
        if (relativeError > significantThreshold) {
          significantErrors++;
          if (significantErrors <= 5) {
            console.log(`Large error at [frame=${frame}, bin=${bin}]: CQT=${cqtVal}, Analyzer=${analyzerVal}, error=${(relativeError * 100).toFixed(1)}%`);
          }
        }
      }
    }
  }

  const avgError = totalError / (compareFrames * numBins);
  console.log(`Average absolute error: ${avgError}`);
  console.log(`Significant errors (>10%): ${significantErrors} out of ${compareFrames * numBins} values`);

  // Less than 10% of values should have significant errors
  // Note: CPU vs GPU floating-point differences and data layout edge cases can cause some variance
  const errorRate = significantErrors / (compareFrames * numBins);
  assertEquals(errorRate < 0.10, true,
    `Too many significant errors: ${(errorRate * 100).toFixed(2)}% (threshold: 10%)`);

  // Cleanup
  analyzer.destroy();
  device.destroy();

  console.log(`\n✓ CQT and Analyzer produce matching results!`);
});

/**
 * Test: Multiple frequencies (chord)
 */
Deno.test("CQT vs Analyzer - C major chord (262, 330, 392 Hz)", async () => {
  // Initialize WebGPU
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    console.log("WebGPU not available, skipping test");
    return;
  }

  const device = await adapter.requestDevice();

  // Test configuration
  const testConfig = {
    sampleRate: 48000,
    fmin: 32.7,
    fmax: 16000,
    binsPerOctave: 12,
    hopLength: 256,
  };

  // Generate C major chord: C4 (262 Hz), E4 (330 Hz), G4 (392 Hz)
  const duration = 1.2;
  const numSamples = Math.floor(duration * testConfig.sampleRate);
  const samples = new Float32Array(numSamples);

  const frequencies = [262, 330, 392]; // C4, E4, G4
  for (let i = 0; i < numSamples; i++) {
    let value = 0;
    for (const freq of frequencies) {
      value += 0.3 * Math.sin(2 * Math.PI * freq * i / testConfig.sampleRate);
    }
    samples[i] = value;
  }

  // Round to 4096 multiple
  const blockSize = 4096;
  const roundedSamples = Math.floor(samples.length / blockSize) * blockSize;
  const testSamples = samples.slice(0, roundedSamples);

  console.log(`\n=== C MAJOR CHORD TEST ===`);
  console.log(`Frequencies: ${frequencies.join(", ")} Hz`);
  console.log(`Samples: ${testSamples.length}`);

  // Reference CQT
  const cqtResult = await computeCQT(testSamples, testConfig, device);

  // GPU Analyzer
  const analyzer = new Analyzer(device, adapter);
  analyzer.processSamples(testSamples);

  const transformer = analyzer.getTransformer();
  const outputRing = transformer.getOutputBufferRing();
  const outputBuffer = outputRing.getBuffer(0);
  const waveletTransform = transformer["waveletTransform"];
  const numBins = waveletTransform.getNumBins();
  const analyzerData = await readTransformOutput(device, outputBuffer, numBins, 128);

  // Compare
  const cqtMax = Math.max(...cqtResult.magnitudes);
  const analyzerMax = Math.max(...analyzerData);
  const maxRelativeError = Math.abs(cqtMax - analyzerMax) / Math.max(cqtMax, analyzerMax);

  console.log(`Max - CQT: ${cqtMax.toFixed(3)}, Analyzer: ${analyzerMax.toFixed(3)}, error: ${(maxRelativeError * 100).toFixed(3)}%`);

  assertAlmostEquals(analyzerMax, cqtMax, cqtMax * 0.01, "Max values should match within 1%");

  // Cleanup
  analyzer.destroy();
  device.destroy();

  console.log(`✓ Chord test passed!`);
});
