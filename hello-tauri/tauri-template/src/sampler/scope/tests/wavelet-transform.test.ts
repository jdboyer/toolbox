/**
 * Tests for the WaveletTransform class
 */

import { assertEquals, assert } from "@std/assert";
import { WaveletTransform, type CQTConfig } from "../wavelet-transform.ts";
import { getTestDevice, readGPUBuffer } from "./test-helpers.ts";
import { generateSineSweep, generateMultiSine } from "./audio-generators.ts";
import { saveCQTAsPNG, hasNonZeroData } from "./image-helpers.ts";

Deno.test("WaveletTransform - basic CQT with sine sweep", async () => {
  const device = await getTestDevice();

  // Configuration
  const sampleRate = 48000;
  const blockSize = 4096;
  const batchFactor = 8; // 8 time frames per block
  const maxBlocks = 4;

  const config: CQTConfig = {
    sampleRate,
    fMin: 55, // A1
    fMax: 1760, // A6
    binsPerOctave: 12,
    blockSize,
    batchFactor,
    maxBlocks,
  };

  const waveletTransform = new WaveletTransform(device, config);

  // Generate a sine sweep from 100Hz to 1000Hz over 1 second
  const duration = 1.0; // seconds
  const numSamples = Math.floor(sampleRate * duration);
  const audioData = generateSineSweep({
    startFrequency: 100,
    endFrequency: 1000,
    sampleRate,
    duration,
    amplitude: 0.8,
    sweepType: "logarithmic",
  });

  // Create input buffer
  const inputBuffer = device.createBuffer({
    size: audioData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(inputBuffer, 0, audioData);

  // Configure the transform
  waveletTransform.configure(inputBuffer, numSamples);

  // Process multiple blocks to generate CQT data
  const hopLength = waveletTransform.getHopLength();
  const numFramesPerBlock = batchFactor;
  const totalFramesToCompute = numFramesPerBlock * 3; // Process 3 blocks worth

  let outputOffset = 0;
  for (let block = 0; block < 3; block++) {
    const inputOffset = block * blockSize;

    // Check if we have enough input samples
    if (inputOffset + blockSize <= numSamples) {
      waveletTransform.transform(inputOffset, outputOffset, numFramesPerBlock);
      outputOffset += numFramesPerBlock;
    }
  }

  // Read back the output buffer
  const outputBuffer = waveletTransform.getOutputBuffer();
  const numBins = waveletTransform.getNumBins();
  const maxTimeFrames = waveletTransform.getMaxTimeFrames();

  // Read only the portion we wrote
  const outputData = await readGPUBuffer(
    device,
    outputBuffer,
    0,
    outputOffset * numBins * 4
  );

  // Verify output is not empty
  const hasData = hasNonZeroData(outputData);
  assert(hasData, "CQT output should contain non-zero data");

  // Save as PNG image for visual inspection
  const outputPath = "src/sampler/scope/tests/output/cqt_sine_sweep.png";

  // Create output directory if it doesn't exist
  try {
    await Deno.mkdir("src/sampler/scope/tests/output", { recursive: true });
  } catch {
    // Directory might already exist
  }

  await saveCQTAsPNG(outputData, outputOffset, numBins, outputPath);
  console.log(`CQT output saved to ${outputPath}`);

  // Verify file was created and has non-zero size
  const fileInfo = await Deno.stat(outputPath);
  assert(fileInfo.size > 0, "Output PNG file should not be empty");

  // Cleanup
  inputBuffer.destroy();
  waveletTransform.destroy();
});

Deno.test("WaveletTransform - multi-tone signal", async () => {
  const device = await getTestDevice();

  // Configuration
  const sampleRate = 48000;
  const blockSize = 2048;
  const batchFactor = 4;
  const maxBlocks = 8;

  const config: CQTConfig = {
    sampleRate,
    fMin: 100,
    fMax: 2000,
    binsPerOctave: 24, // Higher resolution
    blockSize,
    batchFactor,
    maxBlocks,
  };

  const waveletTransform = new WaveletTransform(device, config);

  // Generate a signal with multiple sine waves (chord: C major - 261.63, 329.63, 392.00 Hz)
  const duration = 0.5; // seconds
  const numSamples = Math.floor(sampleRate * duration);
  const audioData = generateMultiSine(
    [261.63, 329.63, 392.00], // C4, E4, G4
    sampleRate,
    duration,
    0.7
  );

  // Create input buffer
  const inputBuffer = device.createBuffer({
    size: audioData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(inputBuffer, 0, audioData);

  // Configure the transform
  waveletTransform.configure(inputBuffer, numSamples);

  // Process 2 blocks
  const numFramesPerBlock = batchFactor;
  let outputOffset = 0;

  for (let block = 0; block < 2; block++) {
    const inputOffset = block * blockSize;
    if (inputOffset + blockSize <= numSamples) {
      waveletTransform.transform(inputOffset, outputOffset, numFramesPerBlock);
      outputOffset += numFramesPerBlock;
    }
  }

  // Read back output
  const outputBuffer = waveletTransform.getOutputBuffer();
  const numBins = waveletTransform.getNumBins();

  const outputData = await readGPUBuffer(
    device,
    outputBuffer,
    0,
    outputOffset * numBins * 4
  );

  // Verify output has data
  const hasData = hasNonZeroData(outputData);
  assert(hasData, "CQT output should contain non-zero data for multi-tone signal");

  // Save as PNG
  const outputPath = "src/sampler/scope/tests/output/cqt_chord.png";

  try {
    await Deno.mkdir("src/sampler/scope/tests/output", { recursive: true });
  } catch {
    // Directory might already exist
  }

  await saveCQTAsPNG(outputData, outputOffset, numBins, outputPath);
  console.log(`CQT output saved to ${outputPath}`);

  // Verify file was created
  const fileInfo = await Deno.stat(outputPath);
  assert(fileInfo.size > 0, "Output PNG file should not be empty");

  // Cleanup
  inputBuffer.destroy();
  waveletTransform.destroy();
});

Deno.test("WaveletTransform - configuration validation", async () => {
  const device = await getTestDevice();

  // Test that blockSize must be power of 2
  try {
    new WaveletTransform(device, {
      sampleRate: 48000,
      fMin: 100,
      fMax: 1000,
      binsPerOctave: 12,
      blockSize: 4095, // Not a power of 2
      batchFactor: 8,
      maxBlocks: 4,
    });
    assert(false, "Should have thrown error for non-power-of-2 blockSize");
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes("power of 2"));
  }

  // Test that blockSize must be divisible by batchFactor
  try {
    new WaveletTransform(device, {
      sampleRate: 48000,
      fMin: 100,
      fMax: 1000,
      binsPerOctave: 12,
      blockSize: 4096,
      batchFactor: 7, // 4096 is not divisible by 7
      maxBlocks: 4,
    });
    assert(false, "Should have thrown error for invalid batchFactor");
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes("divisible"));
  }

  // Test that maxBlocks must be positive integer
  try {
    new WaveletTransform(device, {
      sampleRate: 48000,
      fMin: 100,
      fMax: 1000,
      binsPerOctave: 12,
      blockSize: 4096,
      batchFactor: 8,
      maxBlocks: 0,
    });
    assert(false, "Should have thrown error for zero maxBlocks");
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes("positive integer"));
  }
});

Deno.test("WaveletTransform - output buffer properties", async () => {
  const device = await getTestDevice();

  const config: CQTConfig = {
    sampleRate: 48000,
    fMin: 110,
    fMax: 880,
    binsPerOctave: 12,
    blockSize: 4096,
    batchFactor: 8,
    maxBlocks: 16,
  };

  const waveletTransform = new WaveletTransform(device, config);

  // Verify calculated properties
  assertEquals(waveletTransform.getHopLength(), 4096 / 8);
  assertEquals(waveletTransform.getBatchFactor(), 8);
  assertEquals(waveletTransform.getBlockSize(), 4096);

  // Verify maxTimeFrames = batchFactor * maxBlocks
  const expectedMaxTimeFrames = 8 * 16;
  assertEquals(waveletTransform.getMaxTimeFrames(), expectedMaxTimeFrames);

  // Verify output buffer exists and has correct size
  const outputBuffer = waveletTransform.getOutputBuffer();
  const numBins = waveletTransform.getNumBins();
  const expectedSize = expectedMaxTimeFrames * numBins * 4; // 4 bytes per float

  assertEquals(outputBuffer.size, expectedSize);

  // Cleanup
  waveletTransform.destroy();
});
