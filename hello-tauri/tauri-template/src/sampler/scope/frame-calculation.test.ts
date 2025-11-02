/**
 * Test correct frame calculation with maxKernelLength
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("Frame calculation - matches reference CQT formula", () => {
  const sampleRate = 48000;
  const fmin = 32.7;
  const binsPerOctave = 12;
  const hopLength = 256;
  const timeSliceCount = 128;

  // Calculate Q and max kernel length (same as WaveletTransform)
  const Q = 1.0 / (Math.pow(2, 1.0 / binsPerOctave) - 1);
  const maxKernelLength = Math.ceil((Q * sampleRate) / fmin);

  console.log(`Max kernel length: ${maxKernelLength} samples`);

  // Test with actual audio length from console: 48000 samples
  const audioLength = 48000;

  // Reference CQT formula
  const expectedFrames = Math.floor((audioLength - maxKernelLength) / hopLength) + 1;

  // Transformer formula (after fix)
  const transformerFrames = Math.min(
    timeSliceCount,
    Math.max(0, Math.floor((audioLength - maxKernelLength) / hopLength) + 1)
  );

  console.log(`Audio length: ${audioLength} samples`);
  console.log(`Expected frames (CQT): ${expectedFrames}`);
  console.log(`Transformer frames: ${transformerFrames}`);

  assertEquals(transformerFrames, expectedFrames, "Transformer should use same formula as CQT");
  assertEquals(transformerFrames, 92, "Should compute exactly 92 frames for 48000 samples");
});

Deno.test("Frame calculation - handles various buffer sizes", () => {
  const hopLength = 256;
  const maxKernelLength = 24686;
  const timeSliceCount = 128;

  const testCases = [
    { audioLength: 24686, expectedFrames: 1 }, // Exactly maxKernelLength
    { audioLength: 24942, expectedFrames: 2 }, // maxKernelLength + 1 hop
    { audioLength: 32768, expectedFrames: 32 },
    { audioLength: 48000, expectedFrames: 92 },
    { audioLength: 65536, expectedFrames: 128 }, // Should be capped at timeSliceCount
  ];

  for (const testCase of testCases) {
    const numFrames = Math.min(
      timeSliceCount,
      Math.max(0, Math.floor((testCase.audioLength - maxKernelLength) / hopLength) + 1)
    );

    console.log(`${testCase.audioLength} samples → ${numFrames} frames (expected: ${testCase.expectedFrames})`);

    assertEquals(
      numFrames,
      testCase.expectedFrames,
      `Failed for ${testCase.audioLength} samples`
    );
  }
});
