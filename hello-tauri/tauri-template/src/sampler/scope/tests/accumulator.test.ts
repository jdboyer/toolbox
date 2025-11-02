/**
 * Tests for the Accumulator class
 */

import { assertEquals, assertExists } from "@std/assert";
import { Accumulator } from "../accumulator.ts";
import { getTestDevice, readGPUBuffer, assertFloat32ArraysEqual } from "./test-helpers.ts";
import {
  generateSineWave,
  generateSineSweep,
  generateDC,
  generateSilence,
} from "./audio-generators.ts";

Deno.test("Accumulator - basic initialization", async () => {
  const device = await getTestDevice();
  const blockSize = 512;
  const maxBlocks = 16;
  const minWindowSize = 2048;

  const accumulator = new Accumulator(device, blockSize, maxBlocks, minWindowSize);

  assertEquals(accumulator.getBlockSize(), blockSize);
  assertEquals(accumulator.getMaxBlocks(), maxBlocks);
  assertEquals(accumulator.getTotalSamplesWritten(), 0);
  assertEquals(accumulator.getOutputBufferWriteOffset(), 0);

  accumulator.destroy();
});

Deno.test("Accumulator - add single block", async () => {
  const device = await getTestDevice();
  const blockSize = 512;
  const maxBlocks = 16;
  const minWindowSize = 2048;

  const accumulator = new Accumulator(device, blockSize, maxBlocks, minWindowSize);

  // Generate test data (one block)
  const testData = generateSineWave({
    frequency: 440,
    sampleRate: 48000,
    duration: blockSize / 48000,
    amplitude: 0.5,
  });

  // Add samples
  const blocksCompleted = accumulator.addSamples(testData);

  assertEquals(blocksCompleted, 1, "Should complete exactly 1 block");
  assertEquals(accumulator.getTotalSamplesWritten(), blockSize);
  assertEquals(accumulator.getOutputBufferWriteOffset(), blockSize);

  // Read back from output buffer
  const outputData = await readGPUBuffer(
    device,
    accumulator.getOutputBuffer(),
    0,
    blockSize * 4
  );

  assertFloat32ArraysEqual(
    outputData,
    testData,
    1e-6,
    "Output buffer should contain the same data as input"
  );

  accumulator.destroy();
});

Deno.test("Accumulator - add multiple complete blocks", async () => {
  const device = await getTestDevice();
  const blockSize = 1024;
  const maxBlocks = 16;
  const minWindowSize = 4096;

  const accumulator = new Accumulator(device, blockSize, maxBlocks, minWindowSize);

  // Generate test data (3 blocks)
  const numBlocks = 3;
  const testData = generateSineWave({
    frequency: 880,
    sampleRate: 48000,
    duration: (blockSize * numBlocks) / 48000,
    amplitude: 0.75,
  });

  // Add all samples at once
  const blocksCompleted = accumulator.addSamples(testData);

  assertEquals(blocksCompleted, numBlocks, `Should complete exactly ${numBlocks} blocks`);
  assertEquals(accumulator.getTotalSamplesWritten(), blockSize * numBlocks);
  assertEquals(accumulator.getOutputBufferWriteOffset(), blockSize * numBlocks);

  // Read back from output buffer
  const outputData = await readGPUBuffer(
    device,
    accumulator.getOutputBuffer(),
    0,
    testData.length * 4
  );

  assertFloat32ArraysEqual(
    outputData,
    testData,
    1e-6,
    "Output buffer should contain all blocks in order"
  );

  accumulator.destroy();
});

Deno.test("Accumulator - streaming with partial blocks", async () => {
  const device = await getTestDevice();
  const blockSize = 512;
  const maxBlocks = 16;
  const minWindowSize = 2048;

  const accumulator = new Accumulator(device, blockSize, maxBlocks, minWindowSize);

  // Generate test data
  const totalSamples = blockSize * 2 + 256; // 2.5 blocks
  const testData = generateSineSweep({
    startFrequency: 100,
    endFrequency: 1000,
    sampleRate: 48000,
    duration: totalSamples / 48000,
    amplitude: 0.8,
  });

  // Stream in chunks of various sizes
  const chunkSizes = [100, 200, 300, 150, 400, 200];
  let offset = 0;
  let totalBlocksCompleted = 0;

  for (const chunkSize of chunkSizes) {
    if (offset >= testData.length) break;

    const actualChunkSize = Math.min(chunkSize, testData.length - offset);
    const chunk = testData.subarray(offset, offset + actualChunkSize);

    const blocksCompleted = accumulator.addSamples(chunk);
    totalBlocksCompleted += blocksCompleted;

    offset += actualChunkSize;
  }

  // Add remaining samples
  if (offset < testData.length) {
    const remainingChunk = testData.subarray(offset);
    totalBlocksCompleted += accumulator.addSamples(remainingChunk);
  }

  assertEquals(totalBlocksCompleted, 2, "Should complete 2 full blocks");
  assertEquals(accumulator.getTotalSamplesWritten(), totalSamples);

  // Read back completed blocks from output buffer
  const outputData = await readGPUBuffer(
    device,
    accumulator.getOutputBuffer(),
    0,
    blockSize * 2 * 4 // Only read the completed blocks
  );

  assertFloat32ArraysEqual(
    outputData,
    testData.subarray(0, blockSize * 2),
    1e-6,
    "Output buffer should contain completed blocks with correct data"
  );

  accumulator.destroy();
});

Deno.test("Accumulator - ring buffer behavior", async () => {
  const device = await getTestDevice();
  const blockSize = 256;
  const maxBlocks = 4; // Small ring buffer
  const minWindowSize = 512;

  const accumulator = new Accumulator(device, blockSize, maxBlocks, minWindowSize);

  // Add more blocks than the ring buffer can hold
  const numBlocks = 10;
  const testData = generateDC(48000, (blockSize * numBlocks) / 48000, 1.0);

  let totalBlocksCompleted = 0;
  for (let i = 0; i < numBlocks; i++) {
    const block = testData.subarray(i * blockSize, (i + 1) * blockSize);
    const completed = accumulator.addSamples(block);
    totalBlocksCompleted += completed;
  }

  assertEquals(totalBlocksCompleted, numBlocks, "Should complete all blocks");
  assertEquals(accumulator.getTotalSamplesWritten(), blockSize * numBlocks);

  // Ring buffer should wrap - we can still read from it
  const ringBuffer = accumulator.getInputRingBuffer();
  const currentBufferIndex = ringBuffer.getCurrentBufferIndex();

  // The current buffer index should have wrapped around
  assertEquals(
    currentBufferIndex,
    numBlocks % maxBlocks,
    "Ring buffer should wrap correctly"
  );

  accumulator.destroy();
});

Deno.test("Accumulator - output buffer overflow and backfill", async () => {
  const device = await getTestDevice();
  const blockSize = 4096;
  const maxBlocks = 64;
  const minWindowSize = 8192;

  const accumulator = new Accumulator(device, blockSize, maxBlocks, minWindowSize);

  // Output buffer size is 4096 * 16 = 65536 samples
  // Fill it beyond capacity to test overflow handling
  const numBlocks = 20; // 20 * 4096 = 81920 samples > 65536
  const testData = generateSineWave({
    frequency: 440,
    sampleRate: 48000,
    duration: (blockSize * numBlocks) / 48000,
    amplitude: 1.0,
  });

  let totalBlocksCompleted = 0;
  for (let i = 0; i < numBlocks; i++) {
    const block = testData.subarray(i * blockSize, (i + 1) * blockSize);
    totalBlocksCompleted += accumulator.addSamples(block);
  }

  assertEquals(totalBlocksCompleted, numBlocks);

  // Output buffer should have wrapped and backfilled
  // We should still be able to read the most recent data
  const outputBufferSize = accumulator.getOutputBufferSize();
  const writeOffset = accumulator.getOutputBufferWriteOffset();

  // Write offset should be less than total samples written due to overflow
  assertEquals(
    writeOffset < totalBlocksCompleted * blockSize,
    true,
    "Write offset should wrap on overflow"
  );

  // Read the current content
  const outputData = await readGPUBuffer(
    device,
    accumulator.getOutputBuffer(),
    0,
    Math.min(writeOffset, outputBufferSize) * 4
  );

  // Should have valid data (not all zeros)
  const hasNonZeroData = outputData.some(val => Math.abs(val) > 0.01);
  assertEquals(hasNonZeroData, true, "Output buffer should contain non-zero data after backfill");

  accumulator.destroy();
});

Deno.test("Accumulator - reset functionality", async () => {
  const device = await getTestDevice();
  const blockSize = 512;
  const maxBlocks = 16;
  const minWindowSize = 2048;

  const accumulator = new Accumulator(device, blockSize, maxBlocks, minWindowSize);

  // Add some data
  const testData = generateSineWave({
    frequency: 440,
    sampleRate: 48000,
    duration: (blockSize * 3) / 48000,
  });

  accumulator.addSamples(testData);

  assertEquals(accumulator.getTotalSamplesWritten(), blockSize * 3);
  assertEquals(accumulator.getOutputBufferWriteOffset(), blockSize * 3);

  // Reset
  accumulator.reset();

  assertEquals(accumulator.getTotalSamplesWritten(), 0, "Total samples should reset to 0");
  assertEquals(accumulator.getOutputBufferWriteOffset(), 0, "Output offset should reset to 0");

  // Output buffer should be cleared
  const outputData = await readGPUBuffer(
    device,
    accumulator.getOutputBuffer(),
    0,
    blockSize * 4
  );

  const allZeros = outputData.every(val => val === 0);
  assertEquals(allZeros, true, "Output buffer should be cleared after reset");

  // Should be able to add data again
  const newData = generateDC(48000, blockSize / 48000, 0.5);
  const blocksCompleted = accumulator.addSamples(newData);

  assertEquals(blocksCompleted, 1);
  assertEquals(accumulator.getTotalSamplesWritten(), blockSize);

  accumulator.destroy();
});

Deno.test("Accumulator - empty input", async () => {
  const device = await getTestDevice();
  const blockSize = 512;
  const maxBlocks = 16;
  const minWindowSize = 2048;

  const accumulator = new Accumulator(device, blockSize, maxBlocks, minWindowSize);

  const emptyData = new Float32Array(0);
  const blocksCompleted = accumulator.addSamples(emptyData);

  assertEquals(blocksCompleted, 0, "Should complete 0 blocks with empty input");
  assertEquals(accumulator.getTotalSamplesWritten(), 0);

  accumulator.destroy();
});

Deno.test("Accumulator - exact block boundary", async () => {
  const device = await getTestDevice();
  const blockSize = 1024;
  const maxBlocks = 16;
  const minWindowSize = 4096;

  const accumulator = new Accumulator(device, blockSize, maxBlocks, minWindowSize);

  // Add exactly one block worth of data in multiple chunks
  const chunk1 = generateSilence(48000, 512 / 48000);
  const chunk2 = generateDC(48000, 512 / 48000, 1.0);

  const completed1 = accumulator.addSamples(chunk1);
  assertEquals(completed1, 0, "First chunk should not complete a block");

  const completed2 = accumulator.addSamples(chunk2);
  assertEquals(completed2, 1, "Second chunk should complete exactly 1 block");

  assertEquals(accumulator.getTotalSamplesWritten(), 1024);

  // Verify the data
  const outputData = await readGPUBuffer(
    device,
    accumulator.getOutputBuffer(),
    0,
    blockSize * 4
  );

  // First half should be zeros, second half should be ones
  const firstHalf = outputData.subarray(0, 512);
  const secondHalf = outputData.subarray(512, 1024);

  const firstHalfZeros = firstHalf.every(val => val === 0);
  const secondHalfOnes = secondHalf.every(val => Math.abs(val - 1.0) < 1e-6);

  assertEquals(firstHalfZeros, true, "First half should be zeros");
  assertEquals(secondHalfOnes, true, "Second half should be ones");

  accumulator.destroy();
});

Deno.test("Accumulator - getInputBuffer access", async () => {
  const device = await getTestDevice();
  const blockSize = 512;
  const maxBlocks = 8;
  const minWindowSize = 2048;

  const accumulator = new Accumulator(device, blockSize, maxBlocks, minWindowSize);

  // Add several blocks
  const numBlocks = 3;
  const testData = generateSineWave({
    frequency: 440,
    sampleRate: 48000,
    duration: (blockSize * numBlocks) / 48000,
  });

  accumulator.addSamples(testData);

  // Access individual input buffers
  for (let i = 0; i < numBlocks; i++) {
    const buffer = accumulator.getInputBuffer(i);
    assertExists(buffer, `Input buffer ${i} should exist`);
    assertEquals(buffer.length, blockSize, `Input buffer ${i} should have correct size`);

    // Verify content
    const expectedBlock = testData.subarray(i * blockSize, (i + 1) * blockSize);
    assertFloat32ArraysEqual(
      buffer,
      expectedBlock,
      1e-6,
      `Input buffer ${i} should contain correct data`
    );
  }

  accumulator.destroy();
});
