/**
 * Tests for the Spectrogram class
 */

import { assertEquals, assert } from "@std/assert";
import { Spectrogram, type SpectrogramConfig } from "../spectrogram.ts";
import { getTestDevice } from "./test-helpers.ts";

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
 * Create a test pattern in a GPU buffer
 * Pattern: gradient from 0 to 1 across time, varying by frequency
 */
function createTestPattern(
  device: GPUDevice,
  numFrames: number,
  numBins: number
): GPUBuffer {
  const data = new Float32Array(numFrames * numBins);

  for (let frame = 0; frame < numFrames; frame++) {
    for (let bin = 0; bin < numBins; bin++) {
      // Create a gradient pattern: varies with time and frequency
      const timeValue = frame / numFrames; // 0 to 1 across time
      const freqValue = bin / numBins; // 0 to 1 across frequency
      data[frame * numBins + bin] = timeValue * 0.5 + freqValue * 0.5;
    }
  }

  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  device.queue.writeBuffer(buffer, 0, data);

  return buffer;
}

Deno.test("Spectrogram - basic initialization", async () => {
  const device = await getTestDevice();

  const config: Partial<SpectrogramConfig> = {
    textureCount: 4,
    framesPerTexture: 1024,
    numBins: 128,
  };

  const spectrogram = new Spectrogram(device, config);

  // Verify configuration
  assertEquals(spectrogram.getTextureCount(), 4);
  assertEquals(spectrogram.getTextureWidth(), 4096); // Actual texture width (4 * 1024)
  assertEquals(spectrogram.getTextureHeight(), 128); // Already power of 2
  assertEquals(spectrogram.getTotalCapacity(), 4 * 1024);
  assertEquals(spectrogram.getWritePosition(), 0);

  // Verify textures were created
  const textures = spectrogram.getTextures();
  assertEquals(textures.length, 4);

  // Cleanup
  spectrogram.destroy();
});

Deno.test("Spectrogram - power of 2 rounding", async () => {
  const device = await getTestDevice();

  const config: Partial<SpectrogramConfig> = {
    textureCount: 2,
    framesPerTexture: 512,
    numBins: 100, // Not a power of 2
  };

  const spectrogram = new Spectrogram(device, config);

  // Should round up to 128 (next power of 2)
  assertEquals(spectrogram.getTextureHeight(), 128);

  // Cleanup
  spectrogram.destroy();
});

Deno.test("Spectrogram - simple test pattern conversion", async () => {
  const device = await getTestDevice();

  const numBins = 64;
  const framesPerTexture = 256;
  const textureCount = 2;

  const config: Partial<SpectrogramConfig> = {
    textureCount,
    framesPerTexture,
    numBins,
  };

  const spectrogram = new Spectrogram(device, config);

  // Create test pattern: 512 frames (2 textures worth)
  const numFrames = 512;
  const inputBuffer = createTestPattern(device, numFrames, numBins);

  // Configure spectrogram
  spectrogram.configure(inputBuffer, numBins, numFrames);

  // Update textures with first 256 frames
  spectrogram.updateTextures(0, 256);

  // Read back first texture
  const texture0 = spectrogram.getTexture(0);
  const textureData = await readTexture(
    device,
    texture0,
    framesPerTexture,
    spectrogram.getTextureHeight()
  );

  // Verify we got data back
  assert(textureData.length > 0, "Texture data should not be empty");

  // Check that we have non-zero values (the pattern should create colors)
  let hasNonZero = false;
  for (let i = 0; i < textureData.length; i++) {
    if (textureData[i] > 0) {
      hasNonZero = true;
      break;
    }
  }
  assert(hasNonZero, "Texture should contain non-zero color values");

  // Verify gradient pattern: later frames should generally have higher values
  // Sample a few points along the time axis at a fixed frequency bin
  const binToCheck = 10;
  const y = binToCheck;

  // Get color values at different time positions (x coordinates)
  const getColorAtX = (x: number): number => {
    const offset = (y * framesPerTexture + x) * 4;
    // Average RGB channels (since we're using a hot colormap)
    return (textureData[offset] + textureData[offset + 1] + textureData[offset + 2]) / 3;
  };

  const earlyColor = getColorAtX(50);
  const lateColor = getColorAtX(200);

  // Later in time should generally have higher intensity due to our gradient pattern
  assert(
    lateColor >= earlyColor,
    `Expected gradient pattern: later time (${lateColor}) should be >= earlier time (${earlyColor})`
  );

  // Cleanup
  inputBuffer.destroy();
  spectrogram.destroy();
});

Deno.test("Spectrogram - multiple texture updates", async () => {
  const device = await getTestDevice();

  const numBins = 32;
  const framesPerTexture = 128;
  const textureCount = 4;

  const config: Partial<SpectrogramConfig> = {
    textureCount,
    framesPerTexture,
    numBins,
  };

  const spectrogram = new Spectrogram(device, config);

  // Create test pattern with enough frames to fill multiple textures
  const numFrames = 512;
  const inputBuffer = createTestPattern(device, numFrames, numBins);

  // Configure spectrogram
  spectrogram.configure(inputBuffer, numBins, numFrames);

  // Update first texture region (frames 0-127)
  spectrogram.updateTextures(0, 128);
  assertEquals(spectrogram.getWritePosition(), 1, "Should be in texture index 1 after 128 frames");

  // Update second texture region (frames 128-255)
  spectrogram.updateTextures(128, 256);
  assertEquals(spectrogram.getWritePosition(), 2, "Should be in texture index 2 after 256 frames");

  // Read back both textures and verify they have data
  const texture0 = spectrogram.getTexture(0);
  const data0 = await readTexture(device, texture0, framesPerTexture, spectrogram.getTextureHeight());

  const texture1 = spectrogram.getTexture(1);
  const data1 = await readTexture(device, texture1, framesPerTexture, spectrogram.getTextureHeight());

  // Both textures should have non-zero data
  let hasData0 = false;
  let hasData1 = false;

  for (let i = 0; i < data0.length; i++) {
    if (data0[i] > 0) hasData0 = true;
    if (data1[i] > 0) hasData1 = true;
    if (hasData0 && hasData1) break;
  }

  assert(hasData0, "First texture should contain data");
  assert(hasData1, "Second texture should contain data");

  // Cleanup
  inputBuffer.destroy();
  spectrogram.destroy();
});

Deno.test("Spectrogram - ring buffer wrap-around", async () => {
  const device = await getTestDevice();

  const numBins = 16;
  const framesPerTexture = 64;
  const textureCount = 2; // Small ring buffer for easy wrap testing

  const config: Partial<SpectrogramConfig> = {
    textureCount,
    framesPerTexture,
    numBins,
  };

  const spectrogram = new Spectrogram(device, config);

  const numFrames = 256;
  const inputBuffer = createTestPattern(device, numFrames, numBins);

  spectrogram.configure(inputBuffer, numBins, numFrames);

  // Fill both textures
  spectrogram.updateTextures(0, 64); // Texture 0
  assertEquals(spectrogram.getWritePosition(), 1);

  spectrogram.updateTextures(64, 128); // Texture 1
  assertEquals(spectrogram.getWritePosition(), 0, "Should wrap back to texture 0");

  // Continue writing should overwrite texture 0
  spectrogram.updateTextures(128, 192); // Overwrites texture 0
  assertEquals(spectrogram.getWritePosition(), 1);

  // Cleanup
  inputBuffer.destroy();
  spectrogram.destroy();
});

Deno.test("Spectrogram - reset functionality", async () => {
  const device = await getTestDevice();

  const config: Partial<SpectrogramConfig> = {
    textureCount: 4,
    framesPerTexture: 128,
    numBins: 32,
  };

  const spectrogram = new Spectrogram(device, config);

  const numFrames = 256;
  const inputBuffer = createTestPattern(device, numFrames, 32);

  spectrogram.configure(inputBuffer, 32, numFrames);

  // Update some textures
  spectrogram.updateTextures(0, 128);
  assert(spectrogram.getWritePosition() !== 0, "Write position should have moved");

  // Reset
  spectrogram.reset();
  assertEquals(spectrogram.getWritePosition(), 0, "Reset should return write position to 0");

  // Cleanup
  inputBuffer.destroy();
  spectrogram.destroy();
});

Deno.test("Spectrogram - framesPerTexture validation", async () => {
  const device = await getTestDevice();

  // NOTE: framesPerTexture validation removed - it's legacy code
  // The actual texture size is set in configure() based on input buffer size
  // This test now just verifies that non-power-of-2 values don't crash
  const spectrogram = new Spectrogram(device, {
    textureCount: 2,
    framesPerTexture: 1000, // Not a power of 2 - should be accepted
    numBins: 64,
  });

  // Should not throw
  assert(spectrogram !== null);
  spectrogram.destroy();
});

Deno.test("Spectrogram - color mapping verification", async () => {
  const device = await getTestDevice();

  const numBins = 8;
  const framesPerTexture = 64;

  const config: Partial<SpectrogramConfig> = {
    textureCount: 1,
    framesPerTexture,
    numBins,
  };

  const spectrogram = new Spectrogram(device, config);

  // Create a simple pattern with known values
  const numFrames = 64;
  const data = new Float32Array(numFrames * numBins);

  // Fill with increasing values
  for (let i = 0; i < data.length; i++) {
    data[i] = i / data.length; // 0 to 1
  }

  const inputBuffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(inputBuffer, 0, data);

  spectrogram.configure(inputBuffer, numBins, numFrames);
  spectrogram.updateTextures(0, numFrames);

  // Read back texture
  const texture = spectrogram.getTexture(0);
  const textureData = await readTexture(device, texture, framesPerTexture, spectrogram.getTextureHeight());

  // Verify alpha channel is 255 (opaque)
  for (let i = 0; i < numFrames * numBins; i++) {
    const alphaOffset = i * 4 + 3;
    assertEquals(
      textureData[alphaOffset],
      255,
      `Alpha channel at index ${i} should be 255 (opaque)`
    );
  }

  // Verify that RGB channels increase as magnitude increases
  // Check first pixel vs last pixel in our data
  const firstPixel = [textureData[0], textureData[1], textureData[2]];
  const lastIdx = (numFrames * numBins - 1) * 4;
  const lastPixel = [textureData[lastIdx], textureData[lastIdx + 1], textureData[lastIdx + 2]];

  const firstBrightness = firstPixel[0] + firstPixel[1] + firstPixel[2];
  const lastBrightness = lastPixel[0] + lastPixel[1] + lastPixel[2];

  assert(
    lastBrightness > firstBrightness,
    `Expected increasing brightness: first=${firstBrightness}, last=${lastBrightness}`
  );

  // Cleanup
  inputBuffer.destroy();
  spectrogram.destroy();
});
