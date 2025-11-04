/**
 * Tests for the ScopeRenderer class
 * Validates that ScopeRenderer can render the same spectrogram data as transformer_sine_sweep.png
 */

import { assertEquals, assert } from "@std/assert";
import { Transformer, type TransformerConfig } from "../transformer.ts";
import { ScopeRenderer } from "../scope-renderer.ts";
import { getTestDevice } from "./test-helpers.ts";
import { generateSineSweep } from "./audio-generators.ts";

/**
 * Read texture data back to CPU
 */
async function readTexture(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number
): Promise<Uint8Array> {
  // Create a buffer to copy texture data into
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256; // Must be multiple of 256
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

  // Map and read buffer
  await readBuffer.mapAsync(GPUMapMode.READ);
  const arrayBuffer = readBuffer.getMappedRange();
  const data = new Uint8Array(arrayBuffer.slice(0));
  readBuffer.unmap();
  readBuffer.destroy();

  // Extract actual data (remove padding)
  if (bytesPerRow === width * 4) {
    return data;
  }

  // Remove padding from each row
  const result = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcOffset = y * bytesPerRow;
    const dstOffset = y * width * 4;
    result.set(data.subarray(srcOffset, srcOffset + width * 4), dstOffset);
  }

  return result;
}

/**
 * Save raw RGBA data as PNG
 */
async function saveRGBAAsPNG(
  rgbaData: Uint8Array,
  width: number,
  height: number,
  outputPath: string
): Promise<void> {
  const png = await import("https://deno.land/x/pngs@0.1.1/mod.ts");
  const image = png.encode(rgbaData, width, height);
  await Deno.writeFile(outputPath, image);
}

Deno.test("ScopeRenderer - render sine sweep to offscreen texture", async () => {
  const device = await getTestDevice();

  const sampleRate = 48000;
  const blockSize = 4096;
  const hopLength = 512; // Back to original

  // Create transformer with same config as transformer_sine_sweep test
  const config: Partial<TransformerConfig> = {
    sampleRate,
    blockSize,
    maxBlocks: 128, // Increase to handle 6 seconds of audio (560 frames)
    fMin: 100,
    fMax: 4000,
    binsPerOctave: 12,
    hopLength,
  };

  const transformer = new Transformer(device, config);

  // Generate same sine sweep (6 seconds)
  const duration = 6.0;
  const audioData = generateSineSweep({
    startFrequency: 200,
    endFrequency: 2000,
    sampleRate,
    duration,
    amplitude: 0.8,
    sweepType: "logarithmic",
  });

  // VERIFY THE AUDIO IS ACTUALLY 6 SECONDS OF NON-ZERO DATA
  console.log(`\n=== AUDIO VERIFICATION ===`);
  console.log(`Audio length: ${audioData.length} samples`);
  console.log(`Expected length: ${Math.floor(sampleRate * duration)} samples`);
  console.log(`Duration: ${audioData.length / sampleRate} seconds`);

  // Check first, middle, and last samples
  const firstNonZero = audioData.slice(0, 100).find(x => Math.abs(x) > 0.001);
  const middleNonZero = audioData.slice(Math.floor(audioData.length/2), Math.floor(audioData.length/2) + 100).find(x => Math.abs(x) > 0.001);
  const lastNonZero = audioData.slice(-100).find(x => Math.abs(x) > 0.001);

  console.log(`First 100 samples have non-zero: ${firstNonZero !== undefined}`);
  console.log(`Middle 100 samples have non-zero: ${middleNonZero !== undefined}`);
  console.log(`Last 100 samples have non-zero: ${lastNonZero !== undefined}`);
  console.log(`Sample at 0s: ${audioData[0]}`);
  console.log(`Sample at 3s: ${audioData[Math.floor(sampleRate * 3)]}`);
  console.log(`Sample at 5.9s: ${audioData[Math.floor(sampleRate * 5.9)]}`);

  // Calculate frames FIRST
  const batchFactor = blockSize / hopLength;
  const numBlocks = Math.floor(audioData.length / blockSize);
  const totalFrames = numBlocks * batchFactor;

  // Process audio
  console.log(`\n=== PROCESSING AUDIO ===`);
  console.log(`Audio samples: ${audioData.length}`);
  console.log(`Expected blocks: ${numBlocks}`);
  transformer.addSamples(audioData);
  console.log(`Processing complete`);

  // DEBUG: Check how many CQT frames were actually generated
  const accumulator = transformer.getAccumulator();
  const waveletTransform = transformer.getWaveletTransform();
  const cqtMaxFrames = waveletTransform.getMaxTimeFrames();
  console.log(`\n=== CQT BUFFER DEBUG ===`);
  console.log(`CQT buffer max frames: ${cqtMaxFrames}`);
  console.log(`Expected frames from audio: ${totalFrames}`);
  console.log(`Blocks to process: ${numBlocks}`);
  console.log(`WaveletTransform hopLength: ${waveletTransform.getHopLength()}`);
  console.log(`WaveletTransform batchFactor: ${waveletTransform.getBatchFactor()}`);
  console.log(`WaveletTransform blockSize: ${waveletTransform.getBlockSize()}`);

  // Check actual transformer state
  const transformerConfig = transformer.getConfig();
  console.log(`Transformer hopLength from config: ${transformerConfig.hopLength}`);

  // Get spectrogram
  const spectrogram = transformer.getSpectrogram();
  const textureWidth = spectrogram.getTextureWidth();
  const textureHeight = spectrogram.getTextureHeight();
  const numBins = transformer.getWaveletTransform().getNumBins();

  console.log(`\n=== ScopeRenderer Test ===`);
  console.log(`Texture: ${textureWidth}x${textureHeight}`);
  console.log(`Bins: ${numBins}`);
  console.log(`Total frames calculated: ${totalFrames}`);
  console.log(`Frames written by spectrogram: ${spectrogram.getFramesWritten()}`);
  console.log(`Write position: ${spectrogram.getWritePositionInFrames()}`);
  console.log(`validDataRatio: ${spectrogram.getFramesWritten() / textureWidth}`);
  console.log(`Audio duration: ${duration}s, samples: ${audioData.length}, blocks: ${numBlocks}`);

  // Create ScopeRenderer
  const renderer = new ScopeRenderer(device, spectrogram);

  // Create an offscreen texture to render to
  // Use the data size for the final image (stretches valid data across full canvas)
  const renderWidth = totalFrames;  // Actual data frames (2240)
  const renderHeight = numBins;      // 64 frequency bins

  const offscreenTexture = device.createTexture({
    size: { width: renderWidth, height: renderHeight, depthOrArrayLayers: 1 },
    format: "bgra8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  // Mock canvas context that uses our offscreen texture
  const mockContext = {
    configure: () => {},
    unconfigure: () => {},
    getCurrentTexture: () => offscreenTexture,
  } as GPUCanvasContext;

  // Initialize renderer with mock canvas
  const mockCanvas = {
    getContext: () => mockContext,
    width: renderWidth,
    height: renderHeight,
  } as HTMLCanvasElement;

  const initialized = renderer.initialize(mockCanvas);
  assert(initialized, "Renderer should initialize");

  // Recreate bind group AFTER data has been written to spectrogram
  console.log(`\nRecreating bind group after spectrogram data is ready...`);
  renderer.recreateBindGroup();

  // Render frame
  renderer.render();

  // BYPASS RENDERER - Read the spectrogram texture directly to debug
  const spectrogramTexture = spectrogram.getTextureArray();
  if (!spectrogramTexture) throw new Error("No texture!");

  console.log(`\nReading spectrogram texture directly (first ${renderWidth} pixels of ${textureWidth})`);
  const directData = await readTexture(
    device,
    spectrogramTexture,
    renderWidth,  // Only read the data portion (2240 pixels)
    renderHeight
  );

  // Analyze DIRECT texture data first
  console.log(`\n=== DIRECT TEXTURE DATA ANALYSIS ===`);
  let directLastNonBlackX = -1;
  let directFirstNonBlackX = -1;
  for (let x = 0; x < renderWidth; x++) {
    let hasData = false;
    for (let y = 0; y < renderHeight; y++) {
      const idx = (y * renderWidth + x) * 4;
      const r = directData[idx];
      const g = directData[idx + 1];
      const b = directData[idx + 2];
      if (r > 10 || g > 10 || b > 10) {
        hasData = true;
        break;
      }
    }
    if (hasData) {
      if (directFirstNonBlackX === -1) directFirstNonBlackX = x;
      directLastNonBlackX = x;
    }
  }
  console.log(`Direct texture - First non-black: ${directFirstNonBlackX}, Last non-black: ${directLastNonBlackX}`);
  console.log(`Direct texture - Data range: ${directFirstNonBlackX} to ${directLastNonBlackX} (${directLastNonBlackX - directFirstNonBlackX + 1} pixels)`);

  // Save direct texture data
  const directOutputPath = "src/sampler/scope/tests/output/spectrogram_texture_direct.png";
  await saveRGBAAsPNG(directData, renderWidth, renderHeight, directOutputPath);
  console.log(`Direct spectrogram texture saved to ${directOutputPath}`);

  // Now also read the rendered output
  const renderedData = await readTexture(
    device,
    offscreenTexture,
    renderWidth,
    renderHeight
  );

  // Save as PNG
  const outputPath = "src/sampler/scope/tests/output/scope_renderer_sine_sweep.png";

  try {
    await Deno.mkdir("src/sampler/scope/tests/output", { recursive: true });
  } catch {
    // Directory exists
  }

  // ANALYZE THE PIXEL DATA TO SEE WHERE THE SWEEP ACTUALLY ENDS
  console.log(`\n=== PIXEL DATA ANALYSIS ===`);
  let lastNonBlackX = -1;
  let firstNonBlackX = -1;
  const columnsWithData = [];
  for (let x = 0; x < renderWidth; x++) {
    let hasData = false;
    for (let y = 0; y < renderHeight; y++) {
      const idx = (y * renderWidth + x) * 4;
      const r = renderedData[idx];
      const g = renderedData[idx + 1];
      const b = renderedData[idx + 2];
      // Check if pixel is not black (has some color)
      if (r > 10 || g > 10 || b > 10) {
        hasData = true;
        break;
      }
    }
    if (hasData) {
      if (firstNonBlackX === -1) firstNonBlackX = x;
      lastNonBlackX = x;
      columnsWithData.push(x);
    }
  }

  console.log(`Rendered PNG: ${renderWidth}x${renderHeight}`);
  console.log(`First non-black column: ${firstNonBlackX}`);
  console.log(`Last non-black column: ${lastNonBlackX}`);
  console.log(`Columns with data: ${columnsWithData.length}/${renderWidth}`);
  console.log(`Data coverage: ${((columnsWithData.length) / renderWidth * 100).toFixed(1)}%`);
  console.log(`Expected: 100% (data should span full width)`);

  console.log(`\nSaving PNG: ${renderWidth}x${renderHeight}`);
  await saveRGBAAsPNG(renderedData, renderWidth, renderHeight, outputPath);
  console.log(`ScopeRenderer output saved to ${outputPath}`);
  console.log(`This should match transformer_sine_sweep.png`);

  // Verify file was created
  const fileInfo = await Deno.stat(outputPath);
  assert(fileInfo.size > 0, "Output PNG should not be empty");

  // Cleanup
  offscreenTexture.destroy();
  renderer.destroy();
  transformer.destroy();
});
