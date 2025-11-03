/**
 * Tests for the Transformer class (full pipeline integration)
 */

import { assertEquals, assert } from "@std/assert";
import { Transformer, type TransformerConfig } from "../transformer.ts";
import { getTestDevice } from "./test-helpers.ts";
import { generateSineSweep, generateMultiSine } from "./audio-generators.ts";
import { saveCQTAsPNG } from "./image-helpers.ts";

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
 * Save spectrogram textures as a single PNG image
 * Combines multiple textures horizontally
 * Note: Textures already have colors applied by the GPU shader, so we save them directly
 */
async function saveSpectrogramTextures(
  device: GPUDevice,
  textures: GPUTexture[],
  textureWidth: number,
  textureHeight: number,
  numBins: number,
  totalFrames: number,
  outputPath: string
): Promise<void> {
  // Calculate how many textures we actually need to read
  const texturesNeeded = Math.ceil(totalFrames / textureWidth);
  const texturesToRead = Math.min(texturesNeeded, textures.length);

  // Read all texture data
  const textureDataArray: Uint8Array[] = [];
  for (let i = 0; i < texturesToRead; i++) {
    const data = await readTexture(device, textures[i], textureWidth, textureHeight);
    textureDataArray.push(data);
  }

  // Combine textures into a single RGBA image
  // Width = totalFrames, Height = numBins (not textureHeight, which may be padded)
  const combinedWidth = totalFrames;
  const combinedHeight = numBins;
  const combinedRGBA = new Uint8Array(combinedWidth * combinedHeight * 4);

  for (let textureIdx = 0; textureIdx < texturesToRead; textureIdx++) {
    const textureData = textureDataArray[textureIdx];

    // Copy this texture's data to the combined image
    const startX = textureIdx * textureWidth;
    const framesToCopy = Math.min(textureWidth, totalFrames - startX);

    for (let x = 0; x < framesToCopy; x++) {
      for (let y = 0; y < numBins; y++) {
        // Source: texture layout is [y][x] with RGBA
        const srcIdx = (y * textureWidth + x) * 4;

        // Destination: flip vertically so low frequencies are at bottom
        const flippedY = numBins - 1 - y;
        const dstIdx = (flippedY * combinedWidth + (startX + x)) * 4;

        // Copy RGBA values directly (colors already applied by GPU shader)
        combinedRGBA[dstIdx + 0] = textureData[srcIdx + 0]; // R
        combinedRGBA[dstIdx + 1] = textureData[srcIdx + 1]; // G
        combinedRGBA[dstIdx + 2] = textureData[srcIdx + 2]; // B
        combinedRGBA[dstIdx + 3] = 255; // A (force opaque)
      }
    }
  }

  // Save directly as PNG (colors already applied, no need to use saveCQTAsPNG)
  const { encode: encodePNG } = await import("https://deno.land/x/pngs@0.1.1/mod.ts");
  const png = encodePNG(combinedRGBA, combinedWidth, combinedHeight);
  await Deno.writeFile(outputPath, png);
}

Deno.test("Transformer - basic initialization", async () => {
  const device = await getTestDevice();

  const config: Partial<TransformerConfig> = {
    sampleRate: 48000,
    blockSize: 4096,
    maxBlocks: 16,
    hopLength: 512,
  };

  const transformer = new Transformer(device, config);

  // Verify components exist
  assert(transformer.getAccumulator(), "Accumulator should exist");
  assert(transformer.getWaveletTransform(), "WaveletTransform should exist");
  assert(transformer.getSpectrogram(), "Spectrogram should exist");

  // Verify configuration
  const transformerConfig = transformer.getConfig();
  assertEquals(transformerConfig.sampleRate, 48000);
  assertEquals(transformerConfig.blockSize, 4096);
  assertEquals(transformerConfig.hopLength, 512);

  // Cleanup
  transformer.destroy();
});

Deno.test("Transformer - sine sweep full pipeline", async () => {
  const device = await getTestDevice();

  const sampleRate = 48000;
  const blockSize = 4096;
  const hopLength = 512;

  const config: Partial<TransformerConfig> = {
    sampleRate,
    blockSize,
    maxBlocks: 32,
    fMin: 100,
    fMax: 4000,
    binsPerOctave: 12,
    hopLength,
  };

  const transformer = new Transformer(device, config);

  // Generate a 2-second sine sweep from 200Hz to 2000Hz
  const duration = 2.0;
  const audioData = generateSineSweep({
    startFrequency: 200,
    endFrequency: 2000,
    sampleRate,
    duration,
    amplitude: 0.8,
    sweepType: "logarithmic",
  });

  // Process audio through the transformer
  transformer.addSamples(audioData);

  // Get the spectrogram
  const spectrogram = transformer.getSpectrogram();
  const textures = spectrogram.getTextures();
  const textureWidth = spectrogram.getTextureWidth();
  const textureHeight = spectrogram.getTextureHeight();
  const numBins = transformer.getWaveletTransform().getNumBins();

  // Calculate how many frames were generated
  const batchFactor = blockSize / hopLength;
  const numBlocks = Math.floor(audioData.length / blockSize);
  const totalFrames = numBlocks * batchFactor;

  console.log(`Generated ${totalFrames} time frames across ${textures.length} textures`);
  console.log(`Texture dimensions: ${textureWidth}x${textureHeight}, Actual bins: ${numBins}`);

  // Verify we have textures with data
  assert(textures.length > 0, "Should have created textures");

  // Save spectrogram as PNG
  const outputPath = "src/sampler/scope/tests/output/transformer_sine_sweep.png";

  try {
    await Deno.mkdir("src/sampler/scope/tests/output", { recursive: true });
  } catch {
    // Directory might already exist
  }

  await saveSpectrogramTextures(
    device,
    textures,
    textureWidth,
    textureHeight,
    numBins,
    totalFrames,
    outputPath
  );

  console.log(`Spectrogram saved to ${outputPath}`);

  // Verify file was created
  const fileInfo = await Deno.stat(outputPath);
  assert(fileInfo.size > 0, "Output PNG file should not be empty");

  // Cleanup
  transformer.destroy();
});

Deno.test("Transformer - multi-tone signal", async () => {
  const device = await getTestDevice();

  const sampleRate = 48000;
  const blockSize = 2048;
  const hopLength = 256;

  const config: Partial<TransformerConfig> = {
    sampleRate,
    blockSize,
    maxBlocks: 32,
    fMin: 200,
    fMax: 2000,
    binsPerOctave: 24, // Higher resolution
    hopLength,
  };

  const transformer = new Transformer(device, config);

  // Generate a chord: A4, C#5, E5 (440, 554.37, 659.25 Hz)
  const duration = 1.5;
  const audioData = generateMultiSine(
    [440, 554.37, 659.25],
    sampleRate,
    duration,
    0.7
  );

  // Process audio
  transformer.addSamples(audioData);

  // Get spectrogram
  const spectrogram = transformer.getSpectrogram();
  const textures = spectrogram.getTextures();
  const textureWidth = spectrogram.getTextureWidth();
  const textureHeight = spectrogram.getTextureHeight();
  const numBins = transformer.getWaveletTransform().getNumBins();

  // Calculate total frames
  const batchFactor = blockSize / hopLength;
  const numBlocks = Math.floor(audioData.length / blockSize);
  const totalFrames = numBlocks * batchFactor;

  console.log(`Multi-tone: ${totalFrames} frames, ${numBins} bins`);

  // Save spectrogram
  const outputPath = "src/sampler/scope/tests/output/transformer_chord.png";

  try {
    await Deno.mkdir("src/sampler/scope/tests/output", { recursive: true });
  } catch {
    // Directory might already exist
  }

  await saveSpectrogramTextures(
    device,
    textures,
    textureWidth,
    textureHeight,
    numBins,
    totalFrames,
    outputPath
  );

  console.log(`Chord spectrogram saved to ${outputPath}`);

  // Verify file
  const fileInfo = await Deno.stat(outputPath);
  assert(fileInfo.size > 0, "Output PNG file should not be empty");

  // Cleanup
  transformer.destroy();
});

Deno.test("Transformer - streaming audio in chunks", async () => {
  const device = await getTestDevice();

  const sampleRate = 48000;
  const blockSize = 4096;
  const hopLength = 512;

  const config: Partial<TransformerConfig> = {
    sampleRate,
    blockSize,
    maxBlocks: 16,
    fMin: 100,
    fMax: 2000,
    binsPerOctave: 12,
    hopLength,
  };

  const transformer = new Transformer(device, config);

  // Generate audio
  const duration = 1.0;
  const audioData = generateSineSweep({
    startFrequency: 100,
    endFrequency: 1000,
    sampleRate,
    duration,
    amplitude: 0.7,
    sweepType: "linear",
  });

  // Stream in small chunks (simulate real-time processing)
  const chunkSize = 1024;
  let processedSamples = 0;

  while (processedSamples < audioData.length) {
    const remainingSamples = audioData.length - processedSamples;
    const currentChunkSize = Math.min(chunkSize, remainingSamples);
    const chunk = audioData.subarray(processedSamples, processedSamples + currentChunkSize);

    transformer.addSamples(chunk);
    processedSamples += currentChunkSize;
  }

  // Verify spectrogram was updated
  const spectrogram = transformer.getSpectrogram();
  const textures = spectrogram.getTextures();
  assert(textures.length > 0, "Should have textures");

  // Read first texture to verify it has data
  const texture0 = textures[0];
  const textureData = await readTexture(
    device,
    texture0,
    spectrogram.getTextureWidth(),
    spectrogram.getTextureHeight()
  );

  // Check for non-zero values
  let hasData = false;
  for (let i = 0; i < textureData.length; i++) {
    if (textureData[i] > 0) {
      hasData = true;
      break;
    }
  }

  assert(hasData, "Texture should contain non-zero data after streaming");

  // Cleanup
  transformer.destroy();
});

Deno.test("Transformer - reset functionality", async () => {
  const device = await getTestDevice();

  const config: Partial<TransformerConfig> = {
    sampleRate: 48000,
    blockSize: 4096,
    maxBlocks: 16,
    hopLength: 512,
  };

  const transformer = new Transformer(device, config);

  // Generate and process some audio
  const audioData = generateSineSweep({
    startFrequency: 200,
    endFrequency: 800,
    sampleRate: 48000,
    duration: 0.5,
    amplitude: 0.7,
    sweepType: "linear",
  });

  transformer.addSamples(audioData);

  // Verify some processing happened
  const accumulator = transformer.getAccumulator();
  const writeOffsetBefore = accumulator.getOutputBufferWriteOffset();
  assert(writeOffsetBefore > 0, "Should have processed some samples");

  // Reset
  transformer.reset();

  // Verify reset worked
  const writeOffsetAfter = accumulator.getOutputBufferWriteOffset();
  assertEquals(writeOffsetAfter, 0, "Accumulator write offset should be 0 after reset");

  const spectrogramWritePos = transformer.getSpectrogram().getWritePosition();
  assertEquals(spectrogramWritePos, 0, "Spectrogram write position should be 0 after reset");

  // Cleanup
  transformer.destroy();
});

Deno.test("Transformer - buffer to texture mapping sanity check", async () => {
  const device = await getTestDevice();

  const sampleRate = 48000;
  const blockSize = 4096;
  const hopLength = 512;

  const config: Partial<TransformerConfig> = {
    sampleRate,
    blockSize,
    maxBlocks: 32,
    fMin: 100,
    fMax: 2000,
    binsPerOctave: 12,
    hopLength,
  };

  const transformer = new Transformer(device, config);

  // Generate enough audio to trigger multiple blocks for a good visualization
  // Use 32 blocks to get a nice wide spectrogram (not enough to wrap around)
  const numBlocks = 32;
  const numSamples = numBlocks * blockSize;
  const audioData = generateSineSweep({
    startFrequency: 200,
    endFrequency: 1500,
    sampleRate,
    duration: numSamples / sampleRate,
    amplitude: 0.8,
    sweepType: "logarithmic",
  });

  // Process audio
  transformer.addSamples(audioData);

  // Get the CQT output buffer (raw magnitudes)
  const waveletTransform = transformer.getWaveletTransform();
  const cqtBuffer = waveletTransform.getOutputBuffer();
  const numBins = waveletTransform.getNumBins();
  const batchFactor = blockSize / hopLength;
  const totalFrames = numBlocks * batchFactor;

  console.log(`Sanity check: ${totalFrames} frames, ${numBins} bins`);

  // Read CQT buffer data
  const cqtBufferSize = totalFrames * numBins * 4; // float32
  const readBuffer = device.createBuffer({
    size: cqtBufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const commandEncoder = device.createCommandEncoder();
  commandEncoder.copyBufferToBuffer(cqtBuffer, 0, readBuffer, 0, cqtBufferSize);
  device.queue.submit([commandEncoder.finish()]);

  await readBuffer.mapAsync(GPUMapMode.READ);
  const cqtData = new Float32Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();
  readBuffer.destroy();

  // Get texture data
  const spectrogram = transformer.getSpectrogram();
  const texture0 = spectrogram.getTexture(0);
  const textureWidth = spectrogram.getTextureWidth();
  const textureHeight = spectrogram.getTextureHeight();

  const textureData = await readTexture(device, texture0, textureWidth, textureHeight);

  console.log(`Texture dimensions: ${textureWidth}x${textureHeight}`);

  // Debug: Check a few sample values
  console.log(`Sample CQT magnitudes (first 5): ${Array.from(cqtData.slice(0, 5)).map(v => v.toFixed(4)).join(", ")}`);
  console.log(`Sample texture RGB (first pixel): R=${textureData[0]}, G=${textureData[1]}, B=${textureData[2]}, A=${textureData[3]}`);

  // Debug: Check data layout - compare CQT buffer vs texture at a specific location
  // Let's check frame=10, bin=20
  const testFrame = 10;
  const testBin = 20;
  const cqtIdx = testFrame * numBins + testBin;
  const texIdx = (testBin * textureWidth + testFrame) * 4;
  console.log(`Debug frame=${testFrame}, bin=${testBin}:`);
  console.log(`  CQT buffer value: ${cqtData[cqtIdx].toFixed(4)}`);
  console.log(`  Texture RGB: R=${textureData[texIdx]}, G=${textureData[texIdx+1]}, B=${textureData[texIdx+2]}`);

  // Count non-zero values
  let nonZeroCQT = 0;
  let nonZeroTexture = 0;
  for (let i = 0; i < totalFrames * numBins; i++) {
    if (cqtData[i] > 0.001) nonZeroCQT++;
  }
  for (let i = 0; i < textureWidth * textureHeight; i++) {
    const idx = i * 4;
    if (textureData[idx] > 0 || textureData[idx + 1] > 0 || textureData[idx + 2] > 0) {
      nonZeroTexture++;
    }
  }
  console.log(`Non-zero CQT values: ${nonZeroCQT}/${totalFrames * numBins}`);
  console.log(`Non-zero texture pixels: ${nonZeroTexture}/${textureWidth * textureHeight}`);

  // Convert magnitude to color using the same algorithm as the shader
  // Uses linear scaling with fixed range (matching updated shader)
  const magnitudeToIntensity = (magnitude: number): number => {
    const minVal = 0.0;
    const maxVal = 2.0;
    const range = maxVal - minVal;
    const normalized = Math.max(0, Math.min(1, (magnitude - minVal) / range));
    return normalized;
  };

  const intensityToColor = (intensity: number): [number, number, number] => {
    let r = 0, g = 0, b = 0;

    if (intensity < 0.33) {
      const t = intensity / 0.33;
      r = t;
    } else if (intensity < 0.66) {
      const t = (intensity - 0.33) / 0.33;
      r = 1.0;
      g = t;
    } else {
      const t = (intensity - 0.66) / 0.34;
      r = 1.0;
      g = 1.0;
      b = t;
    }

    return [r, g, b];
  };

  // Compare the data
  // CQT buffer layout: [frame][bin]
  // Texture layout: [x=frame][y=bin] with RGBA pixels
  let totalDifference = 0;
  let maxDifference = 0;
  let comparisons = 0;

  for (let frame = 0; frame < totalFrames; frame++) {
    for (let bin = 0; bin < numBins; bin++) {
      // Read from CQT buffer
      const bufferIdx = frame * numBins + bin;
      const magnitude = cqtData[bufferIdx];

      // Calculate expected color
      const intensity = magnitudeToIntensity(magnitude);
      const [r, g, b] = intensityToColor(intensity);

      // Read from texture
      const texX = frame;
      const texY = bin;
      const texIdx = (texY * textureWidth + texX) * 4;
      const texR = textureData[texIdx] / 255.0;
      const texG = textureData[texIdx + 1] / 255.0;
      const texB = textureData[texIdx + 2] / 255.0;

      // Calculate difference (L2 norm of RGB difference)
      const diff = Math.sqrt(
        Math.pow(r - texR, 2) +
        Math.pow(g - texG, 2) +
        Math.pow(b - texB, 2)
      );

      totalDifference += diff;
      maxDifference = Math.max(maxDifference, diff);
      comparisons++;
    }
  }

  const avgDifference = totalDifference / comparisons;

  console.log(`Average color difference: ${avgDifference.toFixed(6)}`);
  console.log(`Max color difference: ${maxDifference.toFixed(6)}`);
  console.log(`Comparisons: ${comparisons}`);

  // The differences should be very small (allowing for minor float precision differences)
  // and definitely not indicating a major layout issue
  assert(avgDifference < 0.05, `Average difference ${avgDifference} is too high - possible layout mismatch`);
  assert(maxDifference < 0.2, `Max difference ${maxDifference} is too high - possible layout mismatch`);

  // Additional sanity check: non-zero values should be in the same positions
  let mismatchCount = 0;
  for (let frame = 0; frame < totalFrames; frame++) {
    for (let bin = 0; bin < numBins; bin++) {
      const bufferIdx = frame * numBins + bin;
      const magnitude = cqtData[bufferIdx];

      const texX = frame;
      const texY = bin;
      const texIdx = (texY * textureWidth + texX) * 4;
      const texBrightness = (textureData[texIdx] + textureData[texIdx + 1] + textureData[texIdx + 2]) / 3;

      const bufferHasData = magnitude > 0.01;
      const textureHasData = texBrightness > 2; // > ~2/255 in brightness

      if (bufferHasData !== textureHasData) {
        mismatchCount++;
      }
    }
  }

  const mismatchRate = mismatchCount / comparisons;
  console.log(`Data presence mismatch rate: ${(mismatchRate * 100).toFixed(2)}%`);

  // Allow higher mismatch rate for low-magnitude values (they may fall below detection thresholds)
  assert(mismatchRate < 0.20, `Mismatch rate ${mismatchRate} is too high - data not in expected positions`);

  console.log("✓ Buffer to texture mapping verified correctly");

  // Save the sanity check area as a PNG for visual inspection
  const outputPath = "src/sampler/scope/tests/output/transformer_sanity_check.png";

  try {
    await Deno.mkdir("src/sampler/scope/tests/output", { recursive: true });
  } catch {
    // Directory might already exist
  }

  // Extract the region we actually wrote (totalFrames x numBins) as RGBA
  const sanityCheckImageData = new Uint8Array(totalFrames * numBins * 4);
  for (let y = 0; y < numBins; y++) {
    for (let x = 0; x < totalFrames; x++) {
      // Read from texture (X=frame/time, Y=bin/frequency)
      const texX = x;
      const texY = y;
      const texIdx = (texY * textureWidth + texX) * 4;

      // Flip vertically so low frequencies are at bottom
      const flippedY = numBins - 1 - y;
      const imgIdx = (flippedY * totalFrames + x) * 4;

      // Copy RGBA data directly (already colored by shader)
      sanityCheckImageData[imgIdx + 0] = textureData[texIdx + 0]; // R
      sanityCheckImageData[imgIdx + 1] = textureData[texIdx + 1]; // G
      sanityCheckImageData[imgIdx + 2] = textureData[texIdx + 2]; // B
      sanityCheckImageData[imgIdx + 3] = 255; // A
    }
  }

  // Save directly as PNG (already has colors from shader)
  const { encode: encodePNG } = await import("https://deno.land/x/pngs@0.1.1/mod.ts");
  const png = encodePNG(sanityCheckImageData, totalFrames, numBins);
  await Deno.writeFile(outputPath, png);
  console.log(`Sanity check visualization saved to ${outputPath}`);

  // Cleanup
  transformer.destroy();
});

Deno.test("Transformer - complex frequency sweep", async () => {
  const device = await getTestDevice();

  const sampleRate = 48000;
  const blockSize = 4096;
  const hopLength = 512;

  const config: Partial<TransformerConfig> = {
    sampleRate,
    blockSize,
    maxBlocks: 64,
    fMin: 50,
    fMax: 8000,
    binsPerOctave: 12,
    hopLength,
  };

  const transformer = new Transformer(device, config);

  // Generate a logarithmic sweep covering a wide frequency range
  const duration = 3.0;
  const audioData = generateSineSweep({
    startFrequency: 50,
    endFrequency: 8000,
    sampleRate,
    duration,
    amplitude: 0.8,
    sweepType: "logarithmic",
  });

  // Process audio
  transformer.addSamples(audioData);

  // Get spectrogram info
  const spectrogram = transformer.getSpectrogram();
  const textures = spectrogram.getTextures();
  const textureWidth = spectrogram.getTextureWidth();
  const textureHeight = spectrogram.getTextureHeight();
  const numBins = transformer.getWaveletTransform().getNumBins();

  // Calculate total frames
  const batchFactor = blockSize / hopLength;
  const numBlocks = Math.floor(audioData.length / blockSize);
  const totalFrames = numBlocks * batchFactor;

  console.log(`Complex sweep: ${totalFrames} frames, ${numBins} frequency bins`);
  console.log(`Frequency range: 50Hz to 8000Hz`);

  // Save spectrogram
  const outputPath = "src/sampler/scope/tests/output/transformer_complex_sweep.png";

  try {
    await Deno.mkdir("src/sampler/scope/tests/output", { recursive: true });
  } catch {
    // Directory might already exist
  }

  await saveSpectrogramTextures(
    device,
    textures,
    textureWidth,
    textureHeight,
    numBins,
    totalFrames,
    outputPath
  );

  console.log(`Complex sweep spectrogram saved to ${outputPath}`);

  // Verify file
  const fileInfo = await Deno.stat(outputPath);
  assert(fileInfo.size > 0, "Output PNG file should not be empty");

  // Cleanup
  transformer.destroy();
});

Deno.test("Transformer - compare CQT buffer vs Spectrogram texture output", async () => {
  const device = await getTestDevice();

  // Use simple configuration for easy comparison
  const sampleRate = 48000;
  const blockSize = 4096;
  const batchFactor = 8;

  const duration = 1.0;
  const audioData = generateSineSweep({
    startFrequency: 100,
    endFrequency: 1000,
    sampleRate,
    duration,
    amplitude: 0.8,
    sweepType: "logarithmic",
  });

  const numBlocks = Math.floor(audioData.length / blockSize);
  const totalFrames = numBlocks * batchFactor;
  const requiredMaxBlocks = Math.ceil(totalFrames / batchFactor);

  const config: Partial<TransformerConfig> = {
    sampleRate,
    blockSize,
    maxBlocks: Math.max(requiredMaxBlocks, 4),
    fMin: 55,
    fMax: 1760,
    binsPerOctave: 12,
    hopLength: blockSize / batchFactor,
  };

  const transformer = new Transformer(device, config);

  console.log(`\n=== Comparison Test ===`);
  console.log(`Will process ${numBlocks} blocks, generating ${totalFrames} frames`);

  transformer.addSamples(audioData);

  const waveletTransform = transformer.getWaveletTransform();
  const numBins = waveletTransform.getNumBins();

  console.log(`Number of bins: ${numBins}`);

  // PART 1: Read CQT buffer directly
  const outputBuffer = waveletTransform.getOutputBuffer();
  const bufferSize = totalFrames * numBins * 4;
  const readBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const commandEncoder = device.createCommandEncoder();
  commandEncoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, bufferSize);
  device.queue.submit([commandEncoder.finish()]);

  await readBuffer.mapAsync(GPUMapMode.READ);
  const cqtData = new Float32Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();
  readBuffer.destroy();

  console.log(`CQT buffer: ${totalFrames} frames x ${numBins} bins = ${cqtData.length} values`);

  // Save CQT buffer output
  const cqtOutputPath = "src/sampler/scope/tests/output/comparison_cqt_buffer.png";
  try {
    await Deno.mkdir("src/sampler/scope/tests/output", { recursive: true });
  } catch {
    // Directory might already exist
  }
  await saveCQTAsPNG(cqtData, totalFrames, numBins, cqtOutputPath);
  console.log(`CQT buffer saved to ${cqtOutputPath}`);

  // PART 2: Read spectrogram texture
  const spectrogram = transformer.getSpectrogram();
  const textures = spectrogram.getTextures();
  const textureWidth = spectrogram.getTextureWidth();
  const textureHeight = spectrogram.getTextureHeight();

  console.log(`\nSpectrogram: ${textures.length} textures, ${textureWidth}x${textureHeight} each`);
  console.log(`Write position: ${spectrogram.getWritePosition()}`);

  // Read first texture to see what we have
  const texture0Data = await readTexture(device, textures[0], textureWidth, textureHeight);

  // Count non-zero pixels in first texture
  let nonZeroPixels = 0;
  for (let i = 0; i < textureWidth * textureHeight; i++) {
    const idx = i * 4;
    if (texture0Data[idx] > 0 || texture0Data[idx + 1] > 0 || texture0Data[idx + 2] > 0) {
      nonZeroPixels++;
    }
  }
  console.log(`Non-zero pixels in texture 0: ${nonZeroPixels}/${textureWidth * textureHeight}`);

  // Save spectrogram texture output
  const spectrogramOutputPath = "src/sampler/scope/tests/output/comparison_spectrogram_texture.png";
  await saveSpectrogramTextures(
    device,
    textures,
    textureWidth,
    textureHeight,
    numBins,
    totalFrames,
    spectrogramOutputPath
  );
  console.log(`Spectrogram texture saved to ${spectrogramOutputPath}`);

  console.log(`\n✓ Compare the two images - they should show the same data!`);
  console.log(`  CQT buffer:          ${cqtOutputPath}`);
  console.log(`  Spectrogram texture: ${spectrogramOutputPath}`);

  // Cleanup
  transformer.destroy();
});

Deno.test("Transformer - CQT buffer direct output (matching buffer-comparison)", async () => {
  const device = await getTestDevice();

  // Use EXACT same configuration as buffer-comparison test
  const sampleRate = 48000;
  const blockSize = 4096;
  const batchFactor = 8; // 8 time frames per block

  // Generate EXACT same sine sweep as buffer-comparison test
  const duration = 1.0; // seconds
  const audioData = generateSineSweep({
    startFrequency: 100,
    endFrequency: 1000,
    sampleRate,
    duration,
    amplitude: 0.8,
    sweepType: "logarithmic",
  });

  // Calculate required maxBlocks to hold all frames (same as buffer-comparison test)
  const numBlocks = Math.floor(audioData.length / blockSize);
  const totalFrames = numBlocks * batchFactor;
  const requiredMaxBlocks = Math.ceil(totalFrames / batchFactor);

  console.log(`Will process ${numBlocks} blocks, generating ${totalFrames} frames`);
  console.log(`Required maxBlocks: ${requiredMaxBlocks}`);

  const config: Partial<TransformerConfig> = {
    sampleRate,
    blockSize,
    maxBlocks: Math.max(requiredMaxBlocks, 4), // Ensure we can hold all frames
    fMin: 55, // A1
    fMax: 1760, // A6
    binsPerOctave: 12,
    hopLength: blockSize / batchFactor,
  };

  const transformer = new Transformer(device, config);

  // Process the audio
  console.log(`Processing ${audioData.length} samples`);
  transformer.addSamples(audioData);

  // Debug: Check accumulator state and internal transformer state
  const accumulator = transformer.getAccumulator();
  const accWriteOffset = accumulator.getOutputBufferWriteOffset();
  console.log(`Accumulator write offset: ${accWriteOffset} samples`);

  // Access private fields for debugging (we know the structure from reading the code)
  const transformerConfig = transformer.getConfig();
  console.log(`Transformer config:`, transformerConfig);

  // Read the CQT buffer directly (same as buffer-comparison test)
  // Note: mapAsync will implicitly wait for GPU operations to complete
  const waveletTransform = transformer.getWaveletTransform();
  const outputBuffer = waveletTransform.getOutputBuffer();
  const numBins = waveletTransform.getNumBins();

  // Calculate how many frames were generated (should match our calculations above)
  const framesWritten = totalFrames;

  console.log(`Generated ${framesWritten} frames across ${numBlocks} blocks`);
  console.log(`Number of bins: ${numBins}`);

  // Read the CQT buffer data
  const bufferSize = framesWritten * numBins * 4;
  const readBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const commandEncoder = device.createCommandEncoder();
  commandEncoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, bufferSize);
  device.queue.submit([commandEncoder.finish()]);

  await readBuffer.mapAsync(GPUMapMode.READ);
  const cqtData = new Float32Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();
  readBuffer.destroy();

  // Verify we have data
  let nonZeroCount = 0;
  for (let i = 0; i < cqtData.length; i++) {
    if (Math.abs(cqtData[i]) > 0.0001) nonZeroCount++;
  }
  console.log(`Non-zero values: ${nonZeroCount}/${cqtData.length}`);
  assert(nonZeroCount > 0, "CQT buffer should contain non-zero data");

  // Save using saveCQTAsPNG (same as buffer-comparison test)
  const outputPath = "src/sampler/scope/tests/output/transformer_cqt_direct.png";

  try {
    await Deno.mkdir("src/sampler/scope/tests/output", { recursive: true });
  } catch {
    // Directory might already exist
  }

  await saveCQTAsPNG(cqtData, framesWritten, numBins, outputPath);
  console.log(`CQT buffer output saved to ${outputPath}`);
  console.log(`This should match comparison_transformer.png from buffer-comparison test`);

  // Verify file was created
  const fileInfo = await Deno.stat(outputPath);
  assert(fileInfo.size > 0, "Output PNG file should not be empty");

  // Cleanup
  transformer.destroy();
});
