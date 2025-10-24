// Spectrogram renderer for frequency domain visualization
// Renders a 2D colormap of frequency bins vs time

export interface SpectrogramData {
  // CQT magnitude data in column-major order: magnitudes[frame * numBins + bin]
  magnitudes: Float32Array;
  numBins: number;
  numFrames: number;
  minMagnitude: number;
  maxMagnitude: number;
}

// Generate dummy spectrogram data for testing
function generateDummySpectrogram(
  numFreqBins: number,
  numTimeBins: number,
): SpectrogramData {
  const magnitudes = new Float32Array(numFreqBins * numTimeBins);
  let minMagnitude = Infinity;
  let maxMagnitude = -Infinity;

  for (let frame = 0; frame < numTimeBins; frame++) {
    for (let bin = 0; bin < numFreqBins; bin++) {
      // Create some interesting patterns
      // Lower frequencies (higher bin index) have more energy
      const freqFactor = bin / numFreqBins;

      // Time-varying amplitude with some periodicity
      const timeFactor = Math.sin(frame / numTimeBins * Math.PI * 4);

      // Combine factors to create a pattern
      const magnitude = (freqFactor * 0.6 + 0.2) * (timeFactor * 0.5 + 0.5);

      // Add some noise
      const noise = Math.random() * 0.1;

      const value = Math.max(0, Math.min(1, magnitude + noise));
      magnitudes[frame * numFreqBins + bin] = value;

      minMagnitude = Math.min(minMagnitude, value);
      maxMagnitude = Math.max(maxMagnitude, value);
    }
  }

  return {
    magnitudes,
    numBins: numFreqBins,
    numFrames: numTimeBins,
    minMagnitude,
    maxMagnitude,
  };
}

// Convert hex color to RGB
function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)]
    : [0, 0, 0];
}

// Convert magnitude (0-1) to RGB color using a configurable colormap
// colormap: array of hex color strings for control points
function magnitudeToColor(magnitude: number, colormap: string[]): [number, number, number] {
  // Clamp magnitude to [0, 1]
  const m = Math.max(0, Math.min(1, magnitude));

  // Convert colormap to control points
  // Format: [magnitude, r, g, b]
  const controlPoints: [number, number, number, number][] = colormap.map((hexColor, index) => {
    const [r, g, b] = hexToRgb(hexColor);
    const magnitude = index / (colormap.length - 1);
    return [magnitude, r, g, b];
  });

  // Find the two control points to interpolate between
  let lowerIdx = 0;
  for (let i = 0; i < controlPoints.length - 1; i++) {
    if (m >= controlPoints[i][0] && m <= controlPoints[i + 1][0]) {
      lowerIdx = i;
      break;
    }
  }

  const lower = controlPoints[lowerIdx];
  const upper = controlPoints[lowerIdx + 1];

  // Linear interpolation factor
  const t = (m - lower[0]) / (upper[0] - lower[0]);

  const r = Math.round(lower[1] + (upper[1] - lower[1]) * t);
  const g = Math.round(lower[2] + (upper[2] - lower[2]) * t);
  const b = Math.round(lower[3] + (upper[3] - lower[3]) * t);

  return [r, g, b];
}

export function renderSpectrogram(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: {
    spectrogramData?: SpectrogramData | null;
    timeRange: number;
    timeOffset: number;
    colormap?: string[];
  }
) {
  // Use provided data or generate dummy data
  const spectrogramData = options.spectrogramData || generateDummySpectrogram(256, 512);

  // Default colormap (viridis-like)
  const colormap = options.colormap || [
    "#440154", // Dark purple
    "#3b528b", // Blue
    "#21918c", // Teal
    "#5ec962", // Green
    "#fde725", // Yellow
  ];

  // Create an ImageData object for efficient pixel manipulation
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  // Normalize magnitudes to [0, 1] range
  const magRange = spectrogramData.maxMagnitude - spectrogramData.minMagnitude;
  const normalizeMagnitude = (mag: number) => {
    if (magRange === 0) return 0;
    return (mag - spectrogramData.minMagnitude) / magRange;
  };

  // Render the spectrogram
  // X-axis: time (maps to canvas width)
  // Y-axis: frequency bins (maps to canvas height)
  // Frequency axis is logarithmic but bins are also logarithmic, so mapping is linear

  for (let canvasY = 0; canvasY < height; canvasY++) {
    // Map canvas Y to frequency bin (linear mapping)
    // canvasY=0 -> bin=numBins-1 (highest frequency at top)
    // canvasY=height-1 -> bin=0 (lowest frequency at bottom)
    const binFloat = (spectrogramData.numBins - 1) * (1 - canvasY / height);

    for (let canvasX = 0; canvasX < width; canvasX++) {
      // Map canvas X to time frame
      const frameFloat = (canvasX / width) * (spectrogramData.numFrames - 1);

      // Bilinear interpolation for smooth rendering
      const magnitude = bilinearInterpolate(
        spectrogramData,
        binFloat,
        frameFloat
      );

      // Normalize and convert magnitude to color
      const normalizedMag = normalizeMagnitude(magnitude);
      const [r, g, b] = magnitudeToColor(normalizedMag, colormap);

      // Set pixel in ImageData
      const pixelIndex = (canvasY * width + canvasX) * 4;
      data[pixelIndex] = r;
      data[pixelIndex + 1] = g;
      data[pixelIndex + 2] = b;
      data[pixelIndex + 3] = 255; // Alpha
    }
  }

  // Draw the image data to the canvas
  ctx.putImageData(imageData, 0, 0);
}

// Bilinear interpolation for smooth color transitions
// Data is stored in column-major order: magnitudes[frame * numBins + bin]
function bilinearInterpolate(
  data: SpectrogramData,
  binFloat: number,
  frameFloat: number
): number {
  // Get the four surrounding integer coordinates
  const bin0 = Math.floor(binFloat);
  const bin1 = Math.min(data.numBins - 1, Math.ceil(binFloat));
  const frame0 = Math.floor(frameFloat);
  const frame1 = Math.min(data.numFrames - 1, Math.ceil(frameFloat));

  // Get interpolation factors
  const binT = binFloat - bin0;
  const frameT = frameFloat - frame0;

  // Get the four corner values from column-major order
  const v00 = data.magnitudes[frame0 * data.numBins + bin0] ?? 0;
  const v01 = data.magnitudes[frame1 * data.numBins + bin0] ?? 0;
  const v10 = data.magnitudes[frame0 * data.numBins + bin1] ?? 0;
  const v11 = data.magnitudes[frame1 * data.numBins + bin1] ?? 0;

  // Interpolate along frame axis first
  const v0 = v00 * (1 - frameT) + v01 * frameT;
  const v1 = v10 * (1 - frameT) + v11 * frameT;

  // Then interpolate along bin axis
  return v0 * (1 - binT) + v1 * binT;
}
