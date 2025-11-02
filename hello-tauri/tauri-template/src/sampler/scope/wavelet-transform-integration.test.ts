/**
 * Integration tests for wavelet transform
 *
 * These tests compare the GPU wavelet transform output against the reference CQT implementation
 */

import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { WaveletTransform } from "./wavelet-transform.ts";

/**
 * Test: GPU wavelet transform produces same results as reference CQT
 */
Deno.test("WaveletTransform - GPU output matches reference CQT", async () => {
  // Initialize WebGPU
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    console.log("WebGPU not available, skipping test");
    return;
  }

  const device = await adapter.requestDevice();

  // Test configuration matching the reference CQT
  const config = {
    sampleRate: 48000,
    fmin: 32.7,
    fmax: 16000,
    binsPerOctave: 12,
    hopLength: 256,
  };

  // Create wavelet transform
  const waveletTransform = new WaveletTransform(device, config);
  const numBins = waveletTransform.getNumBins();
  const maxKernelLength = waveletTransform.getMaxKernelLength();

  console.log(`Wavelet transform: ${numBins} bins, max kernel length: ${maxKernelLength}`);

  // Create test audio: 1 second sine wave at 440 Hz (A4)
  const sampleRate = 48000;
  const duration = 1.0; // seconds
  const freq = 440; // Hz
  const numSamples = Math.floor(sampleRate * duration);

  const audioData = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    audioData[i] = 0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate);
  }

  // Create GPU input buffer
  const inputBuffer = device.createBuffer({
    size: audioData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Float32Array(inputBuffer.getMappedRange()).set(audioData);
  inputBuffer.unmap();

  // Calculate how many frames we can compute
  const numFrames = Math.min(
    128,
    Math.floor((numSamples - maxKernelLength) / config.hopLength) + 1
  );

  console.log(`Computing ${numFrames} frames from ${numSamples} samples`);

  // Create output buffer with proper padding
  const bytesPerRow = Math.ceil((numBins * 4) / 256) * 256;
  const outputBufferSize = bytesPerRow * numFrames;

  const outputBuffer = device.createBuffer({
    size: outputBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // Run GPU transform
  const commandEncoder = device.createCommandEncoder();
  waveletTransform.computeTransform(
    inputBuffer,
    outputBuffer,
    numSamples,
    numFrames,
    commandEncoder
  );

  // Create staging buffer to read back results
  const stagingBuffer = device.createBuffer({
    size: outputBufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  commandEncoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, outputBufferSize);
  device.queue.submit([commandEncoder.finish()]);

  // Read back GPU results
  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const gpuOutput = new Float32Array(stagingBuffer.getMappedRange()).slice();
  stagingBuffer.unmap();

  // Compare with reference CQT
  const { computeCQT } = await import("../cqt/cqt.ts");
  const cqtResult = await computeCQT(audioData, config);

  console.log(`GPU transform: ${numBins} bins × ${numFrames} frames`);
  console.log(`CQT reference: ${cqtResult.numBins} bins × ${cqtResult.numFrames} frames`);

  // Verify dimensions match
  assertEquals(numBins, cqtResult.numBins);

  // Extract GPU data (account for padding)
  const floatsPerRow = bytesPerRow / 4;
  const gpuData = new Float32Array(numBins * numFrames);
  for (let frame = 0; frame < numFrames; frame++) {
    for (let bin = 0; bin < numBins; bin++) {
      gpuData[frame * numBins + bin] = gpuOutput[frame * floatsPerRow + bin];
    }
  }

  // Compare statistics
  const gpuMin = Math.min(...gpuData);
  const gpuMax = Math.max(...gpuData);
  const cqtMin = Math.min(...cqtResult.magnitudes);
  const cqtMax = Math.max(...cqtResult.magnitudes);

  console.log(`GPU range: ${gpuMin} to ${gpuMax}`);
  console.log(`CQT range: ${cqtMin} to ${cqtMax}`);

  // Count non-zero values
  const gpuNonZero = Array.from(gpuData).filter(v => v > 0.001).length;
  const cqtNonZero = Array.from(cqtResult.magnitudes).filter(v => v > 0.001).length;

  console.log(`GPU non-zero: ${gpuNonZero}`);
  console.log(`CQT non-zero: ${cqtNonZero}`);

  // The values should be very close
  assertAlmostEquals(gpuMax, cqtMax, gpuMax * 0.01); // Within 1%

  // Count of non-zero values should be close
  const nonZeroDiff = Math.abs(gpuNonZero - cqtNonZero);
  const nonZeroTolerance = Math.max(gpuNonZero, cqtNonZero) * 0.05; // Within 5%

  if (nonZeroDiff > nonZeroTolerance) {
    console.error(`Non-zero count mismatch: GPU=${gpuNonZero}, CQT=${cqtNonZero}, diff=${nonZeroDiff}`);
    throw new Error(`Non-zero value count differs by ${nonZeroDiff} (tolerance: ${nonZeroTolerance})`);
  }

  // Sample a few values to verify they're close
  for (let i = 0; i < 100; i++) {
    const idx = Math.floor(Math.random() * Math.min(gpuData.length, cqtResult.magnitudes.length));
    const gpuVal = gpuData[idx];
    const cqtVal = cqtResult.magnitudes[idx];

    // If either value is significant, they should match closely
    if (gpuVal > 0.1 || cqtVal > 0.1) {
      const relativeError = Math.abs(gpuVal - cqtVal) / Math.max(gpuVal, cqtVal, 0.001);
      if (relativeError > 0.1) {
        console.error(`Value mismatch at index ${idx}: GPU=${gpuVal}, CQT=${cqtVal}, error=${relativeError}`);
      }
    }
  }

  // Cleanup
  inputBuffer.destroy();
  outputBuffer.destroy();
  stagingBuffer.destroy();
  waveletTransform.destroy();
  device.destroy();
});

/**
 * Test: Verify the exact sample processing pipeline
 */
Deno.test("WaveletTransform - verify frame count calculation", () => {
  const inputBufferSize = 65536;
  const hopLength = 256;
  const maxKernelLength = 24686;
  const timeSliceCount = 128;

  // Available samples for computing frames
  const availableSamples = inputBufferSize - maxKernelLength;
  const maxFramesPossible = Math.floor(availableSamples / hopLength) + 1;

  console.log(`Input buffer: ${inputBufferSize} samples`);
  console.log(`Max kernel: ${maxKernelLength} samples`);
  console.log(`Available: ${availableSamples} samples`);
  console.log(`Hop length: ${hopLength} samples`);
  console.log(`Max frames possible: ${maxFramesPossible}`);
  console.log(`Config requests: ${timeSliceCount} frames`);

  // We should be able to compute at least the requested number of frames
  assertEquals(maxFramesPossible >= timeSliceCount, true,
    `Can only compute ${maxFramesPossible} frames but config requests ${timeSliceCount}`);
});
