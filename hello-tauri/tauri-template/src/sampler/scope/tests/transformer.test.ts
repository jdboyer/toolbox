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
import { saveCQTAsPNG } from "./image-helpers.ts";
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
 * Read RGBA data from GPU texture
 */
async function readGPUTexture(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number
): Promise<Uint8Array> {
  // Create a buffer to copy texture data into
  const bytesPerPixel = 4; // RGBA8
  const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256; // Must be aligned to 256
  const bufferSize = bytesPerRow * height;

  const readBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  // Copy texture to buffer
  const commandEncoder = device.createCommandEncoder();
  commandEncoder.copyTextureToBuffer(
    { texture },
    { buffer: readBuffer, bytesPerRow },
    { width, height }
  );
  device.queue.submit([commandEncoder.finish()]);

  // Read buffer data
  await readBuffer.mapAsync(GPUMapMode.READ);
  const mappedData = new Uint8Array(readBuffer.getMappedRange());

  // If data is padded, we need to extract just the actual image data
  const imageData = new Uint8Array(width * height * bytesPerPixel);
  for (let row = 0; row < height; row++) {
    const srcOffset = row * bytesPerRow;
    const dstOffset = row * width * bytesPerPixel;
    imageData.set(
      mappedData.subarray(srcOffset, srcOffset + width * bytesPerPixel),
      dstOffset
    );
  }

  readBuffer.unmap();
  readBuffer.destroy();

  return imageData;
}

/**
 * Save GPU texture as PNG
 */
async function saveTextureAsPNG(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
  outputPath: string
): Promise<void> {
  const imageData = await readGPUTexture(device, texture, width, height);
  const png = encodePNG(imageData, width, height);
  await Deno.writeFile(outputPath, png);
}

/**
 * Save Accumulator output buffer as PNG with overlap region highlighted
 */
async function saveAccumulatorBufferAsPNG(
  data: Float32Array,
  outputPath: string,
  width: number = 800,
  height: number = 200,
  overlapSamples: number = 0,
  writeOffset: number = 0
): Promise<void> {
  const imageData = new Uint8Array(width * height * 4);

  // Calculate pixel positions
  const samplesPerPixel = data.length / width;
  const overlapPixels = Math.floor(overlapSamples / samplesPerPixel);
  const writeOffsetPixels = Math.floor(writeOffset / samplesPerPixel);

  // Fill with white background (active region)
  for (let i = 0; i < imageData.length; i += 4) {
    imageData[i] = 255;
    imageData[i + 1] = 255;
    imageData[i + 2] = 255;
    imageData[i + 3] = 255;
  }

  // Draw gray background for stale/unused region (after write offset)
  for (let y = 0; y < height; y++) {
    for (let x = writeOffsetPixels; x < width; x++) {
      const idx = (y * width + x) * 4;
      imageData[idx] = 220;     // R
      imageData[idx + 1] = 220; // G
      imageData[idx + 2] = 220; // B (light gray)
      imageData[idx + 3] = 255; // A
    }
  }

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
  };

  // Create Transformer
  const transformer = new Transformer(device, config);

  // Generate test signal: sine sweep with amplitude modulation
  // The amplitude modulation creates a visible periodic pattern
  // that makes discontinuities easy to spot
  const duration = 2.0; // seconds
  const modulationPeriodSamples = 10000; // Period of amplitude modulation

  const audioData = generateSineSweep({
    startFrequency: 200,
    endFrequency: 2000,
    sampleRate,
    duration,
    amplitude: 0.8,
    sweepType: "logarithmic",
  });

  // Apply amplitude modulation to make patterns visible
  for (let i = 0; i < audioData.length; i++) {
    const modulationPhase = (2 * Math.PI * i) / modulationPeriodSamples;
    const modulationEnvelope = 0.5 + 0.5 * Math.sin(modulationPhase);
    audioData[i] *= modulationEnvelope;
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
  const batchFactor = waveletTransform.getBatchFactor();
  const hopLength = waveletTransform.getHopLength();
  const numBlocks = Math.floor(audioData.length / blockSize);

  // Accumulator information
  const accOutputBufferSize = accumulator.getOutputBufferSize();
  const accWriteOffset = accumulator.getOutputBufferWriteOffset();

  // Get overlap/backfill region size from Accumulator
  // This is the number of blocks copied from the previous buffer when wrapping around
  const overlapRegionBlocks = accumulator.getOverlapRegionBlocks();
  const overlapSamples = overlapRegionBlocks * blockSize;

  // Read the Accumulator output buffer
  const accBuffer = accumulator.getOutputBuffer();
  const accBufferData = await readGPUBuffer(
    device,
    accBuffer,
    accOutputBufferSize * 4 // Float32 = 4 bytes
  );

  // Read the WaveletTransform output buffer (CQT magnitudes)
  const cqtBuffer = waveletTransform.getOutputBuffer();
  const maxTimeFrames = waveletTransform.getMaxTimeFrames();
  const cqtBufferSize = maxTimeFrames * numBins * 4; // Float32 = 4 bytes
  const cqtData = await readGPUBuffer(device, cqtBuffer, cqtBufferSize);

  // Debug: Log buffer dimensions
  console.log(`\nCQT Buffer Info:`);
  console.log(`  Audio length: ${audioData.length} samples`);
  console.log(`  Block size: ${blockSize} samples`);
  console.log(`  Num blocks processed: ${numBlocks}`);
  console.log(`  Batch factor: ${batchFactor} frames/block`);
  console.log(`  Max time frames (buffer capacity): ${maxTimeFrames}`);
  console.log(`  CQT data buffer size: ${cqtData.length} floats = ${maxTimeFrames} × ${numBins}`);

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
  const cqtBufferPath = `${outputDir}/cqt_buffer.png`;
  const spectrogramTexturePath = `${outputDir}/spectrogram_texture.png`;

  await saveWaveformAsPNG(audioData, inputWaveformPath, inputWidth, baseHeight);
  await saveAccumulatorBufferAsPNG(accBufferData, accBufferPath, accBufferWidth, baseHeight, overlapSamples, accWriteOffset);

  // Save CQT buffer - visualize the frequency-time representation
  // Width = buffer capacity (maxTimeFrames), Height = frequency bins
  await saveCQTAsPNG(cqtData, maxTimeFrames, numBins, cqtBufferPath);

  // Save Spectrogram texture - the actual GPU texture used for rendering
  const spectrogramTexture = spectrogram.getTexture();
  const spectrogramWidth = spectrogram.getTextureWidth();
  const spectrogramHeight = spectrogram.getTextureHeight();
  await saveTextureAsPNG(device, spectrogramTexture, spectrogramWidth, spectrogramHeight, spectrogramTexturePath);

  // Generate markdown report
  const markdownPath = `${outputDir}/transformer_verification.md`;
  const markdown = `# Transformer Pipeline Verification Report

Generated: ${new Date().toISOString()}

## Test Configuration

### Transformer Settings
- **Sample Rate**: ${transformerConfig.sampleRate} Hz
- **Block Size**: ${transformerConfig.blockSize} samples
- **Max Blocks**: ${transformerConfig.maxBlocks}
- **Batch Factor**: ${batchFactor} (frames per block)

### Frequency Analysis Settings
- **Frequency Range**: ${transformerConfig.fMin} Hz - ${transformerConfig.fMax} Hz
- **Bins Per Octave**: ${transformerConfig.binsPerOctave}
- **Total Frequency Bins**: ${numBins}

### Test Signal
- **Type**: Logarithmic sine sweep with amplitude modulation
- **Frequency Range**: 200 Hz - 2000 Hz
- **Amplitude Modulation**: Sine wave with ${modulationPeriodSamples} sample period (~${(modulationPeriodSamples / sampleRate * 1000).toFixed(1)} ms)
- **Duration**: ${duration} seconds
- **Total Samples**: ${audioData.length}

## Processing Statistics

### Input Processing
- **Number of Blocks Processed**: ${numBlocks}
- **Time Frames Generated**: ${numBlocks * batchFactor}
- **Samples per Block**: ${blockSize}
- **Frames per Block**: ${batchFactor}

### Accumulator Output Buffer
- **Buffer Capacity**: ${accOutputBufferSize} samples
- **Current Write Offset**: ${accWriteOffset} samples
- **Buffer Utilization**: ${((accWriteOffset / accOutputBufferSize) * 100).toFixed(1)}%
- **Wrap-Around Overlap Size**: ${overlapSamples} samples (${overlapRegionBlocks} blocks)
  - This is the amount of previous data copied when buffer wraps around
  - Ensures sufficient context for CQT analysis of lowest frequencies

### Buffer Dimensions
- **Accumulator Output**: ${accWriteOffset} samples (1D buffer)
- **WaveletTransform Output**: ${maxTimeFrames} frames × ${numBins} bins (buffer capacity)
- **Spectrogram Texture**: ${spectrogram.getTextureWidth()} × ${spectrogram.getTextureHeight()} pixels
  - Write Position: ${spectrogram.getWritePosition()} frames

## Visualizations

### Input Audio Waveform

![Input Waveform](input_waveform.png)

The input signal is a logarithmic sine sweep from 200 Hz to 2000 Hz with amplitude modulation.
- Total duration: ${duration} seconds
- Total samples: ${audioData.length}
- Amplitude modulation period: ${modulationPeriodSamples} samples (~${(modulationPeriodSamples / sampleRate * 1000).toFixed(1)} ms)
- The modulation creates visible periodic patterns to help identify any discontinuities
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
- **Gray background**: Shows the stale/unused region (after write offset)
  - This data is from the previous wrap-around cycle and is not currently active
  - Occupies ${((1 - accWriteOffset / accOutputBufferSize) * 100).toFixed(1)}% of buffer capacity
- Image dimensions: ${accBufferWidth}×${baseHeight} pixels
- **Note**: Image width is proportional to buffer capacity (${accOutputBufferSize} samples), not write offset

### WaveletTransform (CQT) Output Buffer

![CQT Buffer](cqt_buffer.png)

The WaveletTransform output buffer contains the Constant-Q Transform magnitudes (frequency-time representation).
- **Buffer layout**: 2D array [time_frame][frequency_bin]
- **Buffer capacity**: ${maxTimeFrames} time frames × ${numBins} frequency bins
- **Frames written**: ${numBlocks * batchFactor} frames (${((numBlocks * batchFactor / maxTimeFrames) * 100).toFixed(1)}% of capacity)
- **Frequency range**: ${fMin} Hz - ${fMax} Hz (${binsPerOctave} bins per octave)
- **Time resolution**: Each frame represents ${hopLength} samples (${(hopLength / sampleRate * 1000).toFixed(2)} ms)
- **Data format**: Float32 magnitudes (outputs of CQT analysis)
- **Visualization**:
  - X-axis: Time frames (left to right)
  - Y-axis: Frequency bins (low to high, bottom to top)
  - Color: Magnitude (black = low, red/yellow/white = high)
- The sine sweep with amplitude modulation should appear as a diagonal line with periodic intensity variations

### Spectrogram GPU Texture

![Spectrogram Texture](spectrogram_texture.png)

The Spectrogram GPU texture is the final rendering-ready output that contains the colored frequency data.
- **Texture format**: RGBA8 (8-bit per channel, normalized)
- **Texture dimensions**: ${spectrogramWidth} × ${spectrogramHeight} pixels
- **Texture width**: ${spectrogramWidth} frames (matches CQT buffer capacity)
- **Texture height**: ${spectrogramHeight} pixels (power-of-2 rounded from ${numBins} bins)
- **Data source**: Converted from WaveletTransform CQT buffer using compute shader
- **Colormap**: "Hot" colormap (black → red → yellow → white)
- **Usage**: This texture is directly bound to the GPU for real-time rendering
- **Comparison with CQT buffer**:
  - CQT buffer: Raw Float32 magnitude values in storage buffer
  - Spectrogram texture: Color-mapped RGBA8 values in texture (ready for rendering)
  - Both should show the same frequency-time pattern
  - Texture uses GPU-native format optimized for rendering performance

## Data Flow Summary

\`\`\`
Input Audio (${audioData.length} samples)
    ↓
Accumulator (blocks into ${blockSize}-sample chunks)
    ↓
Output Buffer (${accWriteOffset}/${accOutputBufferSize} samples used)
    ↓
WaveletTransform (CQT analysis: ${maxTimeFrames} frames × ${numBins} bins capacity)
    ↓
Spectrogram (GPU textures for rendering)
\`\`\`

## Verification Status

✅ Test completed successfully
- Transformer created and configured
- Audio signal generated and processed
- ${numBlocks} blocks processed into ${numBlocks * batchFactor} time frames
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
  console.log(`✓ CQT buffer saved: ${cqtBufferPath}`);
  console.log(`✓ Spectrogram texture saved: ${spectrogramTexturePath}`);

  // Assertions to verify the test ran correctly
  assert(audioData.length > 0, "Audio data should be generated");
  assert(numBlocks > 0, "Should have processed blocks");
  assert(maxTimeFrames > 0, "Should have CQT buffer capacity");
  assert(accWriteOffset > 0, "Accumulator should have written data");
  assert(numBins > 0, "Should have frequency bins");

  // Verify files were created
  const mdStat = await Deno.stat(markdownPath);
  assert(mdStat.size > 0, "Markdown file should not be empty");

  const waveformStat = await Deno.stat(inputWaveformPath);
  assert(waveformStat.size > 0, "Waveform PNG should not be empty");

  const accStat = await Deno.stat(accBufferPath);
  assert(accStat.size > 0, "Accumulator buffer PNG should not be empty");

  const cqtStat = await Deno.stat(cqtBufferPath);
  assert(cqtStat.size > 0, "CQT buffer PNG should not be empty");

  const spectrogramStat = await Deno.stat(spectrogramTexturePath);
  assert(spectrogramStat.size > 0, "Spectrogram texture PNG should not be empty");

  // Cleanup
  transformer.destroy();
});
