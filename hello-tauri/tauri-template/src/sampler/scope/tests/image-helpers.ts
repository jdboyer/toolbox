/**
 * Image helpers for saving CQT output as PNG files
 */

import { encode as encodePNG } from "https://deno.land/x/pngs@0.1.1/mod.ts";

/**
 * Convert a 2D CQT output array to a PNG image
 * @param data Float32Array containing CQT magnitudes (row-major: [time][frequency])
 * @param width Number of time frames (columns in image)
 * @param height Number of frequency bins (rows in image)
 * @param outputPath Path to save the PNG file
 */
export async function saveCQTAsPNG(
  data: Float32Array,
  width: number,
  height: number,
  outputPath: string
): Promise<void> {
  // Create RGBA image data
  const imageData = new Uint8Array(width * height * 4);

  // Use fixed normalization range to match GPU shader
  // For typical CQT output, magnitudes range from 0.0 to ~2.0
  const minVal = 0.0;
  const maxVal = 2.0;
  const range = maxVal - minVal;

  // Convert to image (flip vertically so low frequencies are at bottom)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Read from data: data[time_frame][frequency_bin]
      const dataIndex = x * height + y;
      const value = data[dataIndex];

      // Normalize to 0-255 (linear scaling with fixed range)
      const normalized = Math.floor(Math.max(0, Math.min(1, (value - minVal) / range)) * 255);

      // Flip vertically (so low frequencies are at bottom of image)
      const flippedY = height - 1 - y;
      const imageIndex = (flippedY * width + x) * 4;

      // Apply a color map (hot colors for higher values)
      const colorValue = applyColorMap(normalized);
      imageData[imageIndex + 0] = colorValue.r;
      imageData[imageIndex + 1] = colorValue.g;
      imageData[imageIndex + 2] = colorValue.b;
      imageData[imageIndex + 3] = 255; // Alpha
    }
  }

  // Encode as PNG
  const png = encodePNG(imageData, width, height);

  // Write to file
  await Deno.writeFile(outputPath, png);
}

/**
 * Apply a "hot" color map (black -> red -> yellow -> white)
 * @param value Value from 0-255
 * @returns RGB color
 */
function applyColorMap(value: number): { r: number; g: number; b: number } {
  // Hot colormap:
  // 0-85: black to red
  // 85-170: red to yellow
  // 170-255: yellow to white

  if (value < 85) {
    // Black to red
    const t = value / 85;
    return { r: Math.floor(t * 255), g: 0, b: 0 };
  } else if (value < 170) {
    // Red to yellow
    const t = (value - 85) / 85;
    return { r: 255, g: Math.floor(t * 255), b: 0 };
  } else {
    // Yellow to white
    const t = (value - 170) / 85;
    return { r: 255, g: 255, b: Math.floor(t * 255) };
  }
}

/**
 * Check if image data contains non-zero values
 * @param data Float32Array to check
 * @returns true if any value is non-zero
 */
export function hasNonZeroData(data: Float32Array): boolean {
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > 1e-10) {
      return true;
    }
  }
  return false;
}
