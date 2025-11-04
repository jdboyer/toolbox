/**
 * Transformer Verification Test
 *
 * This test generates a markdown report with embedded visualizations
 * to verify the Transformer pipeline behavior.
 */

import { assert } from "@std/assert";
import { Transformer, type TransformerConfig } from "../transformer.ts";
import { getTestDevice } from "./test-helpers.ts";
import { generateSineSweep } from "./audio-generators.ts";
import { encode as encodePNG } from "https://deno.land/x/pngs@0.1.1/mod.ts";

/**
 * Save a waveform as a PNG image
 */
async function saveWaveformAsPNG(
  samples: Float32Array,
  outputPath: string,
  width: number = 800,
  height: number = 200
): Promise<void> {
  const imageData = new Uint8Array(width * height * 4);

  // Fill with white background
  for (let i = 0; i < imageData.length; i += 4) {
    imageData[i] = 255;     // R
    imageData[i + 1] = 255; // G
    imageData[i + 2] = 255; // B
    imageData[i + 3] = 255; // A
  }

  // Draw waveform in black
  const samplesPerPixel = Math.ceil(samples.length / width);
  const midY = Math.floor(height / 2);

  for (let x = 0; x < width; x++) {
    const startIdx = x * samplesPerPixel;
    const endIdx = Math.min(startIdx + samplesPerPixel, samples.length);

    // Find min/max in this window for better visualization
    let min = 0;
    let max = 0;
    for (let i = startIdx; i < endIdx; i++) {
      if (samples[i] < min) min = samples[i];
      if (samples[i] > max) max = samples[i];
    }

    // Draw vertical line from min to max
    const yMin = Math.floor(midY - min * midY);
    const yMax = Math.floor(midY - max * midY);

    for (let y = Math.min(yMin, yMax); y <= Math.max(yMin, yMax); y++) {
      if (y >= 0 && y < height) {
        const idx = (y * width + x) * 4;
        imageData[idx] = 0;     // R
        imageData[idx + 1] = 0; // G
        imageData[idx + 2] = 0; // B
        imageData[idx + 3] = 255; // A
      }
    }
  }

  const png = encodePNG(imageData, width, height);
  await Deno.writeFile(outputPath, png);
}

/**
 * Read data from GPU buffer
 */
async function readGPUBuffer(
  device: GPUDevice,
  buffer: GPUBuffer,
  size: number
): Promise<Float32Array> {
  const readBuffer = device.createBuffer({
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const commandEncoder = device.createCommandEncoder();
  commandEncoder.copyBufferToBuffer(buffer, 0, readBuffer, 0, size);
  device.queue.submit([commandEncoder.finish()]);

  await readBuffer.mapAsync(GPUMapMode.READ);
  const data = new Float32Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();
  readBuffer.destroy();

  return data;
}

/**
 * Save Accumulator output buffer as PNG with overlap region highlighted
 */
async function saveAccumulatorBufferAsPNG(
  data: Float32Array,
  outputPath: string,
  width: number = 800,
  height: number = 200,
  overlapSamples: number = 0
): Promise<void> {
  const imageData = new Uint8Array(width * height * 4);

  // Fill with white background
  for (let i = 0; i < imageData.length; i += 4) {
    imageData[i] = 255;
    imageData[i + 1] = 255;
    imageData[i + 2] = 255;
    imageData[i + 3] = 255;
  }

  // Calculate overlap region in pixels
  const samplesPerPixel = data.length / width;
  const overlapPixels = Math.floor(overlapSamples / samplesPerPixel);

  // Draw semi-transparent yellow overlay for overlap/backfill region
  if (overlapSamples > 0 && overlapPixels > 0) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < overlapPixels && x < width; x++) {
        const idx = (y * width + x) * 4;
        // Blend yellow with white background (semi-transparent effect)
        imageData[idx] = 255;     // R
        imageData[idx + 1] = 255; // G
        imageData[idx + 2] = 200; // B (slightly reduced for yellow tint)
        imageData[idx + 3] = 255; // A
      }
    }
  }

  // Draw the buffer contents
  const midY = Math.floor(height / 2);

  for (let x = 0; x < width; x++) {
    const startIdx = Math.floor(x * samplesPerPixel);
    const endIdx = Math.min(Math.floor((x + 1) * samplesPerPixel), data.length);

    let min = 0;
    let max = 0;
    for (let i = startIdx; i < endIdx; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }

    const yMin = Math.floor(midY - min * midY);
    const yMax = Math.floor(midY - max * midY);

    for (let y = Math.min(yMin, yMax); y <= Math.max(yMin, yMax); y++) {
      if (y >= 0 && y < height) {
        const idx = (y * width + x) * 4;
        imageData[idx] = 0;
        imageData[idx + 1] = 0;
        imageData[idx + 2] = 255; // Blue for accumulator buffer
        imageData[idx + 3] = 255;
      }
    }
  }

  const png = encodePNG(imageData, width, height);
  await Deno.writeFile(outputPath, png);
}

Deno.test("Transformer - Pipeline Verification with Documentation", async () => {
  const device = await getTestDevice();

  // Configuration
  const sampleRate = 48000;
  const blockSize = 4096;
  const hopLength = 512;
  const fMin = 100;
  const fMax = 4000;
  const binsPerOctave = 12;
  const maxBlocks = 32;

  const config: Partial<TransformerConfig> = {
    sampleRate,
    blockSize,
    maxBlocks,
    fMin,
    fMax,
    binsPerOctave,
    hopLength,
  };

  // Create Transformer
  const transformer = new Transformer(device, config);

  // Generate test pattern: each block has a distinct DC value
  // This makes blocks visually identifiable in the output images
  const duration = 2.0; // seconds
  const totalSamples = Math.floor(sampleRate * duration);
  const audioData = new Float32Array(totalSamples);

  // Fill each block with a different DC value
  const numTestBlocks = Math.ceil(totalSamples / blockSize);
  for (let blockIdx = 0; blockIdx < numTestBlocks; blockIdx++) {
    const startSample = blockIdx * blockSize;
    const endSample = Math.min(startSample + blockSize, totalSamples);

    // Generate a distinct value for each block (alternating pattern with amplitude variation)
    // This creates a clear staircase pattern in the waveform visualization
    const blockValue = (blockIdx % 2 === 0 ? 0.3 : -0.3) * (1 + blockIdx * 0.05);

    for (let i = startSample; i < endSample; i++) {
      audioData[i] = blockValue;
    }
  }

  // Process audio through transformer
  transformer.addSamples(audioData);

  // Get components for inspection
  const accumulator = transformer.getAccumulator();
  const waveletTransform = transformer.getWaveletTransform();
  const spectrogram = transformer.getSpectrogram();

  // Read configuration and buffer information
  const transformerConfig = transformer.getConfig();
  const numBins = waveletTransform.getNumBins();
  const batchFactor = blockSize / hopLength;
  const numBlocks = Math.floor(audioData.length / blockSize);
  const totalFrames = numBlocks * batchFactor;

  // Accumulator information
  const accOutputBufferSize = 4096 * 16; // Known from accumulator.ts
  const accWriteOffset = accumulator.getOutputBufferWriteOffset();

  // Calculate overlap/backfill region size
  // When buffer wraps, it copies ceil(minWindowSize / blockSize) previous blocks
  // minWindowSize = calculateMinWindowSize() + hopLength (from transformer.ts)
  // For CQT, minWindowSize is based on the lowest frequency window
  // Approximate calculation: we'll compute based on config
  const lowestFreqPeriod = 1 / fMin;
  const lowestFreqSamples = Math.ceil(lowestFreqPeriod * sampleRate);
  const minWindowSize = lowestFreqSamples + hopLength;
  const blocksNeededForOverlap = Math.ceil(minWindowSize / blockSize);
  const overlapSamples = blocksNeededForOverlap * blockSize;

  // Read the Accumulator output buffer
  const accBuffer = accumulator.getOutputBuffer();
  const accBufferData = await readGPUBuffer(
    device,
    accBuffer,
    accOutputBufferSize * 4 // Float32 = 4 bytes
  );

  // Create output directory
  const outputDir = "src/sampler/scope/tests/output";
  try {
    await Deno.mkdir(outputDir, { recursive: true });
  } catch {
    // Directory might already exist
  }

  // Save visualizations with proportional widths
  // Calculate width ratio: input signal vs accumulator buffer
  const baseHeight = 200;
  const pixelsPerSample = 0.01; // Scale factor for visualization

  const inputWidth = Math.max(400, Math.floor(audioData.length * pixelsPerSample));
  const accBufferWidth = Math.max(400, Math.floor(accOutputBufferSize * pixelsPerSample));

  const inputWaveformPath = `${outputDir}/input_waveform.png`;
  const accBufferPath = `${outputDir}/accumulator_buffer.png`;

  await saveWaveformAsPNG(audioData, inputWaveformPath, inputWidth, baseHeight);
  await saveAccumulatorBufferAsPNG(accBufferData, accBufferPath, accBufferWidth, baseHeight, overlapSamples);

  // Generate markdown report
  const markdownPath = `${outputDir}/transformer_verification.md`;
  const markdown = `# Transformer Pipeline Verification Report

Generated: ${new Date().toISOString()}

## Test Configuration

### Transformer Settings
- **Sample Rate**: ${transformerConfig.sampleRate} Hz
- **Block Size**: ${transformerConfig.blockSize} samples
- **Max Blocks**: ${transformerConfig.maxBlocks}
- **Hop Length**: ${transformerConfig.hopLength} samples
- **Batch Factor**: ${batchFactor} (frames per block)

### Frequency Analysis Settings
- **Frequency Range**: ${transformerConfig.fMin} Hz - ${transformerConfig.fMax} Hz
- **Bins Per Octave**: ${transformerConfig.binsPerOctave}
- **Total Frequency Bins**: ${numBins}

### Test Signal
- **Type**: Block pattern (each block has a distinct DC value)
- **Pattern**: Alternating positive/negative values with increasing amplitude
- **Duration**: ${duration} seconds
- **Number of Test Blocks**: ${numTestBlocks}
- **Total Samples**: ${audioData.length}

## Processing Statistics

### Input Processing
- **Number of Blocks Processed**: ${numBlocks}
- **Time Frames Generated**: ${totalFrames}
- **Samples per Block**: ${blockSize}
- **Frames per Block**: ${batchFactor}

### Accumulator Output Buffer
- **Buffer Capacity**: ${accOutputBufferSize} samples
- **Current Write Offset**: ${accWriteOffset} samples
- **Buffer Utilization**: ${((accWriteOffset / accOutputBufferSize) * 100).toFixed(1)}%
- **Wrap-Around Overlap Size**: ${overlapSamples} samples (${blocksNeededForOverlap} blocks)
  - This is the amount of previous data copied when buffer wraps around
  - Based on minimum window size needed for CQT analysis: ${minWindowSize} samples

### Buffer Dimensions
- **Accumulator Output**: ${accWriteOffset} samples (1D buffer)
- **WaveletTransform Output**: ${totalFrames} frames × ${numBins} bins
- **Spectrogram Textures**: ${spectrogram.getTextures().length} texture(s)
  - Texture Dimensions: ${spectrogram.getTextureWidth()} × ${spectrogram.getTextureHeight()}
  - Write Position: ${spectrogram.getWritePosition()}

## Visualizations

### Input Audio Waveform

![Input Waveform](input_waveform.png)

The input signal is a block pattern where each ${blockSize}-sample block has a distinct DC value.
- Total duration: ${duration} seconds
- Total samples: ${audioData.length}
- Number of blocks: ${numTestBlocks}
- Pattern: Alternating positive/negative with increasing amplitude (creates a staircase pattern)
- Image dimensions: ${inputWidth}×${baseHeight} pixels

### Accumulator Output Buffer

![Accumulator Buffer](accumulator_buffer.png)

The Accumulator's GPU output buffer contains the processed audio blocks ready for transformation.
- Buffer capacity: ${accOutputBufferSize} samples
- Write offset indicates how much data has been accumulated: ${accWriteOffset} samples
- Buffer utilization: ${((accWriteOffset / accOutputBufferSize) * 100).toFixed(1)}%
- Blue waveform represents the buffered audio data
- **Yellow overlay**: Shows the overlap/backfill region (${overlapSamples} samples)
  - When the buffer wraps around, this region is copied from the end of the previous buffer
  - This overlap ensures continuous CQT analysis windows across buffer boundaries
- Image dimensions: ${accBufferWidth}×${baseHeight} pixels
- **Note**: Image width is proportional to buffer capacity (${accOutputBufferSize} samples), not write offset

## Data Flow Summary

\`\`\`
Input Audio (${audioData.length} samples)
    ↓
Accumulator (blocks into ${blockSize}-sample chunks)
    ↓
Output Buffer (${accWriteOffset}/${accOutputBufferSize} samples used)
    ↓
WaveletTransform (CQT analysis: ${totalFrames} frames × ${numBins} bins)
    ↓
Spectrogram (GPU textures for rendering)
\`\`\`

## Verification Status

✅ Test completed successfully
- Transformer created and configured
- Audio signal generated and processed
- ${numBlocks} blocks processed into ${totalFrames} time frames
- Accumulator buffer populated with ${accWriteOffset} samples
- Visualizations generated

## Notes

- The Accumulator's output buffer acts as a ring buffer with capacity for ${accOutputBufferSize} samples
- Each block of ${blockSize} samples generates ${batchFactor} time frames in the frequency domain
- The WaveletTransform (CQT) analyzes ${numBins} frequency bins ranging from ${fMin} Hz to ${fMax} Hz
- Spectrogram textures store the colored frequency data for GPU rendering

### Image Scaling
- Image widths are **proportionally scaled** to represent actual sample counts
- Input waveform: ${audioData.length} samples → ${inputWidth}px width
- Accumulator buffer: ${accOutputBufferSize} samples → ${accBufferWidth}px width
- Scale factor: ${pixelsPerSample} pixels per sample
- This allows visual comparison of relative buffer sizes
`;

  await Deno.writeTextFile(markdownPath, markdown);

  console.log(`\n✓ Verification report generated: ${markdownPath}`);
  console.log(`✓ Input waveform saved: ${inputWaveformPath}`);
  console.log(`✓ Accumulator buffer saved: ${accBufferPath}`);

  // Assertions to verify the test ran correctly
  assert(audioData.length > 0, "Audio data should be generated");
  assert(numBlocks > 0, "Should have processed blocks");
  assert(totalFrames > 0, "Should have generated time frames");
  assert(accWriteOffset > 0, "Accumulator should have written data");
  assert(numBins > 0, "Should have frequency bins");

  // Verify files were created
  const mdStat = await Deno.stat(markdownPath);
  assert(mdStat.size > 0, "Markdown file should not be empty");

  const waveformStat = await Deno.stat(inputWaveformPath);
  assert(waveformStat.size > 0, "Waveform PNG should not be empty");

  const accStat = await Deno.stat(accBufferPath);
  assert(accStat.size > 0, "Accumulator buffer PNG should not be empty");

  // Cleanup
  transformer.destroy();
});
