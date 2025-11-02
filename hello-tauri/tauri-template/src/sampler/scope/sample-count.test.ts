/**
 * Test to diagnose sample count mismatch between CQT and wavelet transform
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("Sample count - verify extraction logic", () => {
  const sampleRate = 48000;
  const startTime = 0.8;
  const endTime = 2.0;
  const blockSize = 4096;

  const startSample = Math.floor(startTime * sampleRate);
  const endSample = Math.floor(endTime * sampleRate);

  let numSamples = endSample - startSample;
  numSamples = Math.floor(numSamples / blockSize) * blockSize;

  console.log(`Sample rate: ${sampleRate} Hz`);
  console.log(`Time range: ${startTime}s to ${endTime}s (${endTime - startTime}s duration)`);
  console.log(`Sample range: ${startSample} to ${endSample}`);
  console.log(`Raw samples: ${endSample - startSample}`);
  console.log(`Rounded to ${blockSize} multiple: ${numSamples} samples`);

  // Verify
  assertEquals(numSamples, 57344, "Should extract 57,344 samples");
});

Deno.test("Sample count - verify frame count for 57k samples", () => {
  const audioLength = 57344;
  const hopLength = 256;
  const maxKernelLength = 24686;
  const timeSliceCount = 128;

  // CQT formula
  const numFrames = Math.floor((audioLength - maxKernelLength) / hopLength) + 1;

  console.log(`Audio length: ${audioLength} samples`);
  console.log(`Max kernel: ${maxKernelLength} samples`);
  console.log(`Available: ${audioLength - maxKernelLength} samples`);
  console.log(`Hop length: ${hopLength} samples`);
  console.log(`Frames: ${numFrames}`);

  // Should be exactly 128 frames
  assertEquals(numFrames, 128, "57,344 samples should produce exactly 128 frames");

  // Verify the math
  const samplesNeededFor128Frames = (128 - 1) * hopLength + maxKernelLength;
  console.log(`Samples needed for 128 frames: ${samplesNeededFor128Frames}`);
  assertEquals(samplesNeededFor128Frames, 57198);
  assertEquals(audioLength >= samplesNeededFor128Frames, true);
});

Deno.test("Sample count - diagnose the 6500 non-zero value issue", () => {
  const cqtNonZero = 13052;
  const gpuNonZero = 6500;
  const totalBins = 108;

  console.log(`CQT non-zero: ${cqtNonZero}`);
  console.log(`GPU non-zero: ${gpuNonZero}`);
  console.log(`Ratio: ${(gpuNonZero / cqtNonZero * 100).toFixed(1)}%`);

  // If GPU is getting roughly half the non-zero values, maybe it's only processing half the frames?
  const estimatedGpuFrames = Math.floor((gpuNonZero / totalBins));
  const estimatedCqtFrames = Math.floor((cqtNonZero / totalBins));

  console.log(`Estimated GPU frames: ~${estimatedGpuFrames} (${gpuNonZero} / ${totalBins})`);
  console.log(`Estimated CQT frames: ~${estimatedCqtFrames} (${cqtNonZero} / ${totalBins})`);

  // 6500 / 108 ≈ 60 frames
  // 13052 / 108 ≈ 121 frames
  console.log("\nThis suggests GPU is computing ~60 frames but CQT is computing ~121 frames");
});

Deno.test("Sample count - how many samples does GPU actually receive?", () => {
  // The accumulator breaks into blocks of 2048
  // If we send 57,344 samples:
  const totalSamples = 57344;
  const blockSize = 2048;
  const inputBufferSize = 65536;

  const numBlocks = Math.floor(totalSamples / blockSize);
  const samplesInBlocks = numBlocks * blockSize;
  const remainingSamples = totalSamples - samplesInBlocks;

  console.log(`Total samples sent: ${totalSamples}`);
  console.log(`Block size: ${blockSize}`);
  console.log(`Number of complete blocks: ${numBlocks}`);
  console.log(`Samples in complete blocks: ${samplesInBlocks}`);
  console.log(`Remaining samples: ${remainingSamples}`);

  // With new logic, doTransform is only called:
  // 1. When buffer is full (>= 65536 samples)
  // 2. On the last block

  let transformOffset = 0;
  for (let i = 0; i < numBlocks; i++) {
    transformOffset += blockSize;

    if (i === numBlocks - 1) {
      console.log(`\nFinal transform called at offset: ${transformOffset} samples`);

      const hopLength = 256;
      const maxKernelLength = 24686;
      const numFrames = Math.floor((transformOffset - maxKernelLength) / hopLength) + 1;
      console.log(`This would compute: ${numFrames} frames`);

      // 57344 samples should give 128 frames
      // But if we're missing the remaining 1024 samples...
      assertEquals(transformOffset, samplesInBlocks);

      if (transformOffset < totalSamples) {
        console.log(`\nPROBLEM: We're missing ${totalSamples - transformOffset} samples!`);
        console.log(`The last partial block is not being processed!`);
      }
    }

    if (transformOffset >= inputBufferSize) {
      console.log(`Buffer full at offset: ${transformOffset}`);
      break;
    }
  }
});
