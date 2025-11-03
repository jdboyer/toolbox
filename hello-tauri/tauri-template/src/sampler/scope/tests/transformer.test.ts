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
 * Convert RGBA texture data to grayscale for saving as PNG
 * Extracts intensity from the hot colormap (black->red->yellow->white)
 */
function rgbaToGrayscale(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const grayscale = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    const r = rgba[offset];
    const g = rgba[offset + 1];
    const b = rgba[offset + 2];

    // Average RGB channels to get intensity
    grayscale[i] = Math.floor((r + g + b) / 3);
  }

  return grayscale;
}

/**
 * Save spectrogram textures as a single PNG image
 * Combines multiple textures horizontally
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

  // Combine textures into a single image
  // Width = totalFrames, Height = numBins (not textureHeight, which may be padded)
  const combinedWidth = totalFrames;
  const combinedHeight = numBins;
  const combinedGrayscale = new Uint8Array(combinedWidth * combinedHeight);

  for (let textureIdx = 0; textureIdx < texturesToRead; textureIdx++) {
    const textureData = textureDataArray[textureIdx];
    const textureGrayscale = rgbaToGrayscale(textureData, textureWidth, textureHeight);

    // Copy this texture's data to the combined image
    const startX = textureIdx * textureWidth;
    const framesToCopy = Math.min(textureWidth, totalFrames - startX);

    for (let x = 0; x < framesToCopy; x++) {
      for (let y = 0; y < numBins; y++) {
        const srcIdx = y * textureWidth + x;
        const dstIdx = y * combinedWidth + (startX + x);
        combinedGrayscale[dstIdx] = textureGrayscale[srcIdx];
      }
    }
  }

  // Save using the existing saveCQTAsPNG function
  // We need to convert grayscale back to Float32Array for compatibility
  const float32Data = new Float32Array(combinedGrayscale.length);
  for (let i = 0; i < combinedGrayscale.length; i++) {
    float32Data[i] = combinedGrayscale[i] / 255.0; // Normalize to 0-1
  }

  await saveCQTAsPNG(float32Data, combinedWidth, combinedHeight, outputPath);
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

  // Generate enough audio to trigger 3 blocks (not enough to wrap around)
  const numBlocks = 3;
  const numSamples = numBlocks * blockSize;
  const audioData = generateSineSweep({
    startFrequency: 200,
    endFrequency: 800,
    sampleRate,
    duration: numSamples / sampleRate,
    amplitude: 0.8,
    sweepType: "linear",
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
  // This is a simplified version for comparison
  const magnitudeToIntensity = (magnitude: number): number => {
    const epsilon = 0.0001;
    const logMag = Math.log(magnitude + epsilon);
    const minLog = Math.log(epsilon);
    const maxLog = Math.log(10.0);
    const normalized = Math.max(0, Math.min(1, (logMag - minLog) / (maxLog - minLog)));
    return Math.pow(normalized, 0.5);
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

  assert(mismatchRate < 0.05, `Mismatch rate ${mismatchRate} is too high - data not in expected positions`);

  console.log("✓ Buffer to texture mapping verified correctly");

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
