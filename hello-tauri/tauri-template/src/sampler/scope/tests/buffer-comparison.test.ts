/**
 * Test to compare WaveletTransform direct output vs Transformer output
 * This test ensures the Transformer produces identical buffer data to WaveletTransform
 */

import { assertEquals, assert } from "@std/assert";
import { WaveletTransform, type CQTConfig } from "../wavelet-transform.ts";
import { Transformer, type TransformerConfig } from "../transformer.ts";
import { getTestDevice, readGPUBuffer } from "./test-helpers.ts";
import { generateSineSweep } from "./audio-generators.ts";
import { saveCQTAsPNG, hasNonZeroData } from "./image-helpers.ts";

Deno.test("Buffer Comparison - Transformer vs WaveletTransform direct", async () => {
  const device = await getTestDevice();

  // Use EXACT same configuration as the wavelet-transform test
  const sampleRate = 48000;
  const blockSize = 4096;
  const batchFactor = 8; // 8 time frames per block
  const maxBlocks = 4;

  // === PART 1: WaveletTransform Direct (original working test) ===

  const waveletConfig: CQTConfig = {
    sampleRate,
    fMin: 55, // A1
    fMax: 1760, // A6
    binsPerOctave: 12,
    blockSize,
    batchFactor,
    maxBlocks,
  };

  const waveletTransform = new WaveletTransform(device, waveletConfig);

  // Generate EXACT same sine sweep
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

  // Create input buffer for WaveletTransform
  const inputBuffer = device.createBuffer({
    size: audioData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(inputBuffer, 0, audioData);

  // Configure the transform
  waveletTransform.configure(inputBuffer, numSamples);

  // Process 3 blocks (same as original test)
  const numFramesPerBlock = batchFactor;
  let framesWritten = 0;

  for (let block = 0; block < 3; block++) {
    const inputOffset = block * blockSize;
    if (inputOffset + blockSize <= numSamples) {
      waveletTransform.transform(inputOffset);
      framesWritten += numFramesPerBlock;
    }
  }

  // Read back the output buffer
  const waveletOutputBuffer = waveletTransform.getOutputBuffer();
  const numBins = waveletTransform.getNumBins();

  const waveletOutputData = await readGPUBuffer(
    device,
    waveletOutputBuffer,
    0,
    framesWritten * numBins * 4
  );

  // Verify output is not empty
  const hasWaveletData = hasNonZeroData(waveletOutputData);
  assert(hasWaveletData, "WaveletTransform output should contain non-zero data");

  // Save WaveletTransform output
  const waveletOutputPath = "src/sampler/scope/tests/output/comparison_wavelet_direct.png";
  try {
    await Deno.mkdir("src/sampler/scope/tests/output", { recursive: true });
  } catch {
    // Directory might already exist
  }
  await saveCQTAsPNG(waveletOutputData, framesWritten, numBins, waveletOutputPath);
  console.log(`WaveletTransform direct output saved to ${waveletOutputPath}`);

  // === PART 2: Transformer (should produce identical data) ===

  // CRITICAL: The Transformer's WaveletTransform has a ring buffer of size maxBlocks * batchFactor
  // We need to ensure it's large enough to hold ALL the frames we'll generate
  const numBlocksToProcess = Math.floor(numSamples / blockSize);
  const totalFramesToGenerate = numBlocksToProcess * batchFactor;
  const requiredMaxBlocks = Math.ceil(totalFramesToGenerate / batchFactor);

  console.log(`\nWill process ${numBlocksToProcess} blocks, generating ${totalFramesToGenerate} frames`);
  console.log(`Required maxBlocks: ${requiredMaxBlocks} (to hold all frames without wrapping)`);

  const transformerConfig: Partial<TransformerConfig> = {
    sampleRate,
    blockSize,
    maxBlocks: Math.max(requiredMaxBlocks, maxBlocks), // Ensure we can hold all frames
    fMin: 55, // A1
    fMax: 1760, // A6
    binsPerOctave: 12,
    hopLength: blockSize / batchFactor, // Same hop length
  };

  const transformer = new Transformer(device, transformerConfig);

  // Process the SAME audio data
  console.log(`\nProcessing ${audioData.length} samples (${numSamples} samples, ${Math.floor(audioData.length / blockSize)} blocks)`);
  transformer.addSamples(audioData);

  // Read back the CQT buffer from Transformer
  const transformerWavelet = transformer.getWaveletTransform();
  const transformerOutputBuffer = transformerWavelet.getOutputBuffer();
  const transformerNumBins = transformerWavelet.getNumBins();

  // Calculate how many frames were generated
  const numBlocks = Math.floor(audioData.length / blockSize);
  const transformerFramesWritten = numBlocks * batchFactor;

  // Debug: Check accumulator state
  const accumulator = transformer.getAccumulator();
  const accWriteOffset = accumulator.getOutputBufferWriteOffset();
  console.log(`Accumulator write offset: ${accWriteOffset} samples`);
  console.log(`Expected frames: ${transformerFramesWritten}, Total bins: ${transformerNumBins}`);

  // CRITICAL: The WaveletTransform uses a ring buffer!
  // We need to read the ENTIRE buffer to get all the data, since we don't know the write position
  const maxTimeFrames = transformerWavelet.getMaxTimeFrames();
  console.log(`Max time frames (ring buffer size): ${maxTimeFrames}`);

  // Read the entire ring buffer
  const entireBufferSize = maxTimeFrames * transformerNumBins * 4;
  const entireBuffer = await readGPUBuffer(
    device,
    transformerOutputBuffer,
    0,
    entireBufferSize
  );

  console.log(`Read entire buffer: ${entireBuffer.length} float32 values`);

  // Count non-zero values in entire buffer
  let nonZeroInEntireBuffer = 0;
  for (let i = 0; i < entireBuffer.length; i++) {
    if (Math.abs(entireBuffer[i]) > 0.0001) nonZeroInEntireBuffer++;
  }
  console.log(`Non-zero values in entire buffer: ${nonZeroInEntireBuffer}/${entireBuffer.length}`);

  // Extract only the frames we actually wrote (first transformerFramesWritten frames)
  // The data layout is: [frame][bin], so frame_i_bin_j is at index (i * numBins + j)
  const transformerOutputData = new Float32Array(transformerFramesWritten * transformerNumBins);
  for (let frame = 0; frame < transformerFramesWritten; frame++) {
    for (let bin = 0; bin < transformerNumBins; bin++) {
      const srcIdx = frame * transformerNumBins + bin;
      const dstIdx = frame * transformerNumBins + bin;
      transformerOutputData[dstIdx] = entireBuffer[srcIdx];
    }
  }

  // Verify output is not empty
  const hasTransformerData = hasNonZeroData(transformerOutputData);
  console.log(`hasNonZeroData result: ${hasTransformerData}`);
  assert(hasTransformerData, "Transformer output should contain non-zero data");

  // Save Transformer output using THE EXACT SAME saveCQTAsPNG function
  const transformerOutputPath = "src/sampler/scope/tests/output/comparison_transformer.png";
  await saveCQTAsPNG(transformerOutputData, transformerFramesWritten, transformerNumBins, transformerOutputPath);
  console.log(`Transformer output saved to ${transformerOutputPath}`);

  // === PART 3: Compare the outputs ===

  console.log("\n=== Comparison Results ===");
  console.log(`WaveletTransform: ${framesWritten} frames, ${numBins} bins`);
  console.log(`Transformer: ${transformerFramesWritten} frames, ${transformerNumBins} bins`);

  // They should have the same dimensions
  assertEquals(transformerNumBins, numBins, "Number of bins should match");

  // The WaveletTransform test processes 3 blocks explicitly, while Transformer processes all complete blocks
  // For this test, we expect them to process the same number of blocks
  console.log(`Note: WaveletTransform processed ${framesWritten} frames (3 blocks manually)`);
  console.log(`      Transformer processed ${transformerFramesWritten} frames (all ${numBlocks} complete blocks)`);

  // Compare the actual data values for the frames both have
  const framesToCompare = Math.min(framesWritten, transformerFramesWritten);

  console.log(`Comparing first ${framesToCompare} frames...`);

  let totalDifference = 0;
  let maxDifference = 0;
  let maxDiffLocation = { frame: 0, bin: 0 };
  let comparisons = 0;
  let significantDifferences = 0;

  for (let frame = 0; frame < framesToCompare; frame++) {
    for (let bin = 0; bin < numBins; bin++) {
      // Both use the same layout: data[frame * numBins + bin]
      const idx = frame * numBins + bin;
      const waveletValue = waveletOutputData[idx];
      const transformerValue = transformerOutputData[idx];

      const diff = Math.abs(waveletValue - transformerValue);
      totalDifference += diff;

      if (diff > maxDifference) {
        maxDifference = diff;
        maxDiffLocation = { frame, bin };
      }

      // Count significant differences (relative to the larger value)
      const maxValue = Math.max(Math.abs(waveletValue), Math.abs(transformerValue), 0.0001);
      const relativeDiff = diff / maxValue;
      if (relativeDiff > 0.01) { // 1% threshold
        significantDifferences++;
      }

      comparisons++;
    }
  }

  const avgDifference = totalDifference / comparisons;
  const significantDiffPercent = (significantDifferences / comparisons) * 100;

  console.log(`\nStatistics:`);
  console.log(`  Average absolute difference: ${avgDifference.toFixed(6)}`);
  console.log(`  Max absolute difference: ${maxDifference.toFixed(6)} at frame=${maxDiffLocation.frame}, bin=${maxDiffLocation.bin}`);
  console.log(`  Significant differences (>1%): ${significantDifferences}/${comparisons} (${significantDiffPercent.toFixed(2)}%)`);

  // Sample some specific values for debugging
  console.log(`\nSample values (frame=5, bin=10):`);
  const sampleIdx = 5 * numBins + 10;
  console.log(`  WaveletTransform: ${waveletOutputData[sampleIdx].toFixed(6)}`);
  console.log(`  Transformer: ${transformerOutputData[sampleIdx].toFixed(6)}`);

  // Log the location of max difference
  const maxDiffIdx = maxDiffLocation.frame * numBins + maxDiffLocation.bin;
  console.log(`\nMax difference location (frame=${maxDiffLocation.frame}, bin=${maxDiffLocation.bin}):`);
  console.log(`  WaveletTransform: ${waveletOutputData[maxDiffIdx].toFixed(6)}`);
  console.log(`  Transformer: ${transformerOutputData[maxDiffIdx].toFixed(6)}`);

  // The outputs should be nearly identical (allowing for minor floating point differences)
  assert(
    avgDifference < 0.001,
    `Average difference ${avgDifference} too high - data layouts may differ`
  );
  assert(
    significantDiffPercent < 5,
    `Too many significant differences: ${significantDiffPercent}% - expected <5%`
  );

  console.log("\n✓ Buffer comparison passed - Transformer produces identical data to WaveletTransform");
  console.log(`✓ Compare images: ${waveletOutputPath} vs ${transformerOutputPath}`);

  // Cleanup
  inputBuffer.destroy();
  waveletTransform.destroy();
  transformer.destroy();
});
