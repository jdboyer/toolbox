/**
 * Data flow diagnostic tests
 *
 * These tests trace the exact flow of data through the pipeline to identify discrepancies
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Accumulator } from "./accumulator.ts";

/**
 * Test: Verify accumulator preserves ALL samples
 */
Deno.test("DataFlow - accumulator preserves all input samples", () => {
  const blockSize = 2048;
  const accumulator = new Accumulator(blockSize, 128);

  // Create known test pattern
  const numSamples = 32768;
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = i / numSamples; // 0.0 to 1.0
  }

  accumulator.addSamples(samples);

  // Reconstruct data from blocks
  const numBlocks = Math.floor(numSamples / blockSize);
  const reconstructed = new Float32Array(numBlocks * blockSize);

  for (let blockIdx = 0; blockIdx < numBlocks; blockIdx++) {
    const block = accumulator.getBlock(blockIdx);
    reconstructed.set(block, blockIdx * blockSize);
  }

  // Verify every sample matches
  for (let i = 0; i < numBlocks * blockSize; i++) {
    assertEquals(reconstructed[i], samples[i],
      `Mismatch at sample ${i}: expected ${samples[i]}, got ${reconstructed[i]}`);
  }

  console.log(`✓ All ${numBlocks * blockSize} samples preserved through accumulator`);
});

/**
 * Test: Verify transformer processes all blocks
 */
Deno.test("DataFlow - count how many transforms occur", () => {
  const blockSize = 2048;
  const inputBufferSize = 65536;
  const numSamples = 48000; // 1 second at 48kHz

  // How many blocks will the accumulator create?
  const numBlocks = Math.floor(numSamples / blockSize);
  console.log(`Input: ${numSamples} samples`);
  console.log(`Block size: ${blockSize} samples`);
  console.log(`Number of blocks: ${numBlocks}`);

  // How many times will doTransform() be called?
  let transformCount = 0;
  let currentOffset = 0;

  for (let blockIdx = 0; blockIdx < numBlocks; blockIdx++) {
    currentOffset += blockSize;

    // Check if this is the last block
    if (blockIdx === numBlocks - 1) {
      transformCount++; // Final transform
      console.log(`Transform ${transformCount}: Final block, offset=${currentOffset}`);
      break;
    }

    // Check if buffer is full
    if (currentOffset >= inputBufferSize) {
      transformCount++;
      console.log(`Transform ${transformCount}: Buffer full, offset=${currentOffset}`);
      // Would call nextInputBuffer() which resets offset to overlap
      currentOffset = 4096; // overlap
    }
  }

  console.log(`Total transforms: ${transformCount}`);
  console.log(`Expected: 1 (since 48000 < 65536, should only transform once at the end)`);

  assertEquals(transformCount, 1, "Should only transform once for 48k samples with 65k buffer");
});

/**
 * Test: Diagnose the exact difference in frame computation
 */
Deno.test("DataFlow - frame computation differences", () => {
  const sampleRate = 48000;
  const fmin = 32.7;
  const binsPerOctave = 12;
  const hopLength = 256;

  // Calculate Q and max kernel length
  const Q = 1.0 / (Math.pow(2, 1.0 / binsPerOctave) - 1);
  const maxKernelLength = Math.ceil((Q * sampleRate) / fmin);

  console.log(`Max kernel length: ${maxKernelLength} samples`);

  // Test with different audio lengths
  const testCases = [
    { name: "32k buffer", samples: 32768 },
    { name: "48k (1 sec)", samples: 48000 },
    { name: "65k buffer", samples: 65536 },
  ];

  for (const testCase of testCases) {
    const audioLength = testCase.samples;

    // Method 1: Reference CQT formula
    const refFrames = Math.floor((audioLength - maxKernelLength) / hopLength) + 1;

    // Method 2: Current transformer formula
    const transformerFrames = Math.min(
      128,
      Math.floor(audioLength / hopLength)
    );

    console.log(`\n${testCase.name} (${audioLength} samples):`);
    console.log(`  Reference CQT: ${refFrames} frames`);
    console.log(`  Transformer: ${transformerFrames} frames`);
    console.log(`  Difference: ${Math.abs(refFrames - transformerFrames)} frames`);
  }
});

/**
 * Test: Verify the exact non-zero value count issue
 */
Deno.test("DataFlow - diagnose non-zero value differences", () => {
  // From your console output:
  const cqtNonZero = 12774;
  const gpuNonZero = 10946;
  const difference = cqtNonZero - gpuNonZero;

  console.log(`CQT non-zero values: ${cqtNonZero}`);
  console.log(`GPU non-zero values: ${gpuNonZero}`);
  console.log(`Missing values: ${difference}`);
  console.log(`Percentage missing: ${(difference / cqtNonZero * 100).toFixed(1)}%`);

  // With 108 bins × 128 frames = 13,824 total values
  const totalValues = 108 * 128;
  console.log(`Total values in output: ${totalValues}`);
  console.log(`CQT zero values: ${totalValues - cqtNonZero} (${((totalValues - cqtNonZero) / totalValues * 100).toFixed(1)}%)`);
  console.log(`GPU zero values: ${totalValues - gpuNonZero} (${((totalValues - gpuNonZero) / totalValues * 100).toFixed(1)}%)`);

  // Are we computing fewer frames than the CQT?
  const missingFrames = Math.floor(difference / 108);
  console.log(`\nIf distributed evenly across bins: ~${missingFrames} frames worth of data missing`);
});
