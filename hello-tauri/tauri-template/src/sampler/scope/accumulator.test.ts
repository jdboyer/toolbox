/**
 * Unit tests for the Accumulator
 *
 * Verifies that samples are correctly stored and retrieved from the ring buffer
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Accumulator } from "./accumulator.ts";

/**
 * Test: Create accumulator with correct initial state
 */
Deno.test("Accumulator - initializes with correct state", () => {
  const blockSize = 2048;
  const maxBlocks = 128;
  const accumulator = new Accumulator(blockSize, maxBlocks);

  assertEquals(accumulator.getProcessBlockIndex(), -1);
  assertEquals(accumulator.getFirstValidBlockIndex(), -1);
  assertEquals(accumulator.getLastValidBlockIndex(), -1);
  assertEquals(accumulator.getMaxBlocks(), maxBlocks);
});

/**
 * Test: Add samples smaller than one block
 */
Deno.test("Accumulator - handles samples smaller than block size", () => {
  const blockSize = 2048;
  const accumulator = new Accumulator(blockSize, 128);

  // Add 1024 samples (half a block)
  const samples = new Float32Array(1024).fill(1.0);
  accumulator.addSamples(samples);

  // No blocks should be marked as valid yet (block not full)
  assertEquals(accumulator.getProcessBlockIndex(), -1);
  assertEquals(accumulator.getFirstValidBlockIndex(), -1);
});

/**
 * Test: Add samples that exactly fill one block
 */
Deno.test("Accumulator - handles samples that fill exactly one block", () => {
  const blockSize = 2048;
  const accumulator = new Accumulator(blockSize, 128);

  // Add exactly one block worth of samples
  const samples = new Float32Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    samples[i] = i / blockSize; // 0.0 to 1.0
  }
  accumulator.addSamples(samples);

  // First block should now be valid
  assertEquals(accumulator.getProcessBlockIndex(), 0);
  assertEquals(accumulator.getFirstValidBlockIndex(), 0);
  assertEquals(accumulator.getLastValidBlockIndex(), 0);

  // Verify the data
  const block = accumulator.getBlock(0);
  assertEquals(block.length, blockSize);
  assertEquals(block[0], 0.0);
  assertEquals(block[blockSize - 1], (blockSize - 1) / blockSize);
});

/**
 * Test: Add samples larger than one block
 */
Deno.test("Accumulator - handles samples spanning multiple blocks", () => {
  const blockSize = 2048;
  const accumulator = new Accumulator(blockSize, 128);

  // Add 3.5 blocks worth of samples
  const totalSamples = Math.floor(blockSize * 3.5);
  const samples = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    samples[i] = i;
  }
  accumulator.addSamples(samples);

  // First 3 blocks should be valid (4th block is only half full)
  assertEquals(accumulator.getProcessBlockIndex(), 0);
  assertEquals(accumulator.getFirstValidBlockIndex(), 0);
  assertEquals(accumulator.getLastValidBlockIndex(), 2); // 0, 1, 2 = 3 blocks

  // Verify data continuity across blocks
  const block0 = accumulator.getBlock(0);
  const block1 = accumulator.getBlock(1);
  assertEquals(block0[blockSize - 1], blockSize - 1);
  assertEquals(block1[0], blockSize);
});

/**
 * Test: Mark blocks as processed
 */
Deno.test("Accumulator - marks blocks as processed correctly", () => {
  const blockSize = 2048;
  const accumulator = new Accumulator(blockSize, 128);

  // Add 2 blocks worth of samples
  const samples = new Float32Array(blockSize * 2).fill(1.0);
  accumulator.addSamples(samples);

  assertEquals(accumulator.getProcessBlockIndex(), 0);

  // Mark as processed
  accumulator.markProcessed();

  // Process index should now be -1 (all processed)
  assertEquals(accumulator.getProcessBlockIndex(), -1);
});

/**
 * Test: Add more samples after processing
 */
Deno.test("Accumulator - handles adding samples after processing", () => {
  const blockSize = 2048;
  const accumulator = new Accumulator(blockSize, 128);

  // Add and process first batch
  const samples1 = new Float32Array(blockSize * 2).fill(1.0);
  accumulator.addSamples(samples1);
  accumulator.markProcessed();

  // Add second batch
  const samples2 = new Float32Array(blockSize).fill(2.0);
  accumulator.addSamples(samples2);

  // Should have new unprocessed block
  assertEquals(accumulator.getProcessBlockIndex(), 2);
  assertEquals(accumulator.getLastValidBlockIndex(), 2);

  // Verify the data
  const block = accumulator.getBlock(2);
  assertEquals(block[0], 2.0);
});

/**
 * Test: Verify data integrity with real audio-like values
 */
Deno.test("Accumulator - preserves audio data integrity", () => {
  const blockSize = 2048;
  const accumulator = new Accumulator(blockSize, 128);

  // Create sine wave samples
  const sampleRate = 48000;
  const freq = 1000; // 1kHz
  const duration = 0.1; // 100ms
  const numSamples = Math.floor(sampleRate * duration);

  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = Math.sin(2 * Math.PI * freq * i / sampleRate);
  }

  accumulator.addSamples(samples);

  // Read back first block and verify
  const block0 = accumulator.getBlock(0);
  for (let i = 0; i < Math.min(100, blockSize); i++) {
    assertEquals(block0[i], samples[i]);
  }
});

/**
 * Test: Large sample array (simulating full WAV file)
 */
Deno.test("Accumulator - handles large sample arrays", () => {
  const blockSize = 2048;
  const accumulator = new Accumulator(blockSize, 128);

  // Simulate a large audio file (1 second at 48kHz)
  const numSamples = 48000;
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = Math.random() * 2 - 1; // Random audio -1 to 1
  }

  accumulator.addSamples(samples);

  // Should have filled: floor(48000 / 2048) = 23 blocks
  const expectedBlocks = Math.floor(numSamples / blockSize);
  assertEquals(accumulator.getLastValidBlockIndex(), expectedBlocks - 1);

  // Verify we can retrieve all blocks
  for (let i = 0; i < expectedBlocks; i++) {
    const block = accumulator.getBlock(i);
    assertEquals(block.length, blockSize);
  }

  console.log(`Processed ${numSamples} samples into ${expectedBlocks} blocks`);
});
