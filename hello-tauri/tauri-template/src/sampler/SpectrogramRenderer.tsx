// Spectrogram renderer for frequency domain visualization
// Renders a 2D colormap of frequency bins vs time

interface SpectrogramData {
  // 2D matrix: rows = frequency bins, columns = time bins
  // spectrogramData[freqBin][timeBin] = magnitude (0-1)
  spectrogramData: number[][];
  numFreqBins: number;
  numTimeBins: number;
  timeRange: number; // Total time range in ms
  timeOffset: number; // Time offset in ms
}

// Generate dummy spectrogram data for testing
function generateDummySpectrogram(
  numFreqBins: number,
  numTimeBins: number,
): number[][] {
  const data: number[][] = [];

  for (let freqBin = 0; freqBin < numFreqBins; freqBin++) {
    const row: number[] = [];
    for (let timeBin = 0; timeBin < numTimeBins; timeBin++) {
      // Create some interesting patterns
      // Lower frequencies (higher freqBin index) have more energy
      const freqFactor = freqBin / numFreqBins;

      // Time-varying amplitude with some periodicity
      const timeFactor = Math.sin(timeBin / numTimeBins * Math.PI * 4);

      // Combine factors to create a pattern
      const magnitude = (freqFactor * 0.6 + 0.2) * (timeFactor * 0.5 + 0.5);

      // Add some noise
      const noise = Math.random() * 0.1;

      row.push(Math.max(0, Math.min(1, magnitude + noise)));
    }
    data.push(row);
  }

  return data;
}

// Convert magnitude (0-1) to RGB color using a perceptually uniform colormap
// Using a viridis-like colormap: dark purple -> blue -> green -> yellow
function magnitudeToColor(magnitude: number): [number, number, number] {
  // Clamp magnitude to [0, 1]
  const m = Math.max(0, Math.min(1, magnitude));

  // Viridis-inspired colormap control points
  // Format: [magnitude, r, g, b]
  const controlPoints: [number, number, number, number][] = [
    [0.0, 68, 1, 84],      // Dark purple
    [0.25, 59, 82, 139],   // Blue
    [0.5, 33, 145, 140],   // Teal
    [0.75, 94, 201, 98],   // Green
    [1.0, 253, 231, 37],   // Yellow
  ];

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
    numFreqBins?: number;
    numTimeBins?: number;
    timeRange: number;
    timeOffset: number;
  }
) {
  const numFreqBins = options.numFreqBins || 256;
  const numTimeBins = options.numTimeBins || 512;

  // Generate dummy data
  const spectrogramData = generateDummySpectrogram(numFreqBins, numTimeBins);

  // Create an ImageData object for efficient pixel manipulation
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  // Render the spectrogram
  // X-axis: time (maps to canvas width)
  // Y-axis: frequency bins (maps to canvas height)
  // Frequency axis is logarithmic but bins are also logarithmic, so mapping is linear

  for (let canvasY = 0; canvasY < height; canvasY++) {
    // Map canvas Y to frequency bin (linear mapping)
    // canvasY=0 -> freqBin=numFreqBins-1 (highest frequency at top)
    // canvasY=height-1 -> freqBin=0 (lowest frequency at bottom)
    const freqBinFloat = (numFreqBins - 1) * (1 - canvasY / height);

    for (let canvasX = 0; canvasX < width; canvasX++) {
      // Map canvas X to time bin
      const timeBinFloat = (canvasX / width) * (numTimeBins - 1);

      // Bilinear interpolation for smooth rendering
      const magnitude = bilinearInterpolate(
        spectrogramData,
        freqBinFloat,
        timeBinFloat,
        numFreqBins,
        numTimeBins
      );

      // Convert magnitude to color
      const [r, g, b] = magnitudeToColor(magnitude);

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
function bilinearInterpolate(
  data: number[][],
  freqBinFloat: number,
  timeBinFloat: number,
  numFreqBins: number,
  numTimeBins: number
): number {
  // Get the four surrounding integer coordinates
  const freqBin0 = Math.floor(freqBinFloat);
  const freqBin1 = Math.min(numFreqBins - 1, Math.ceil(freqBinFloat));
  const timeBin0 = Math.floor(timeBinFloat);
  const timeBin1 = Math.min(numTimeBins - 1, Math.ceil(timeBinFloat));

  // Get interpolation factors
  const freqT = freqBinFloat - freqBin0;
  const timeT = timeBinFloat - timeBin0;

  // Get the four corner values
  const v00 = data[freqBin0]?.[timeBin0] ?? 0;
  const v01 = data[freqBin0]?.[timeBin1] ?? 0;
  const v10 = data[freqBin1]?.[timeBin0] ?? 0;
  const v11 = data[freqBin1]?.[timeBin1] ?? 0;

  // Interpolate along time axis first
  const v0 = v00 * (1 - timeT) + v01 * timeT;
  const v1 = v10 * (1 - timeT) + v11 * timeT;

  // Then interpolate along frequency axis
  return v0 * (1 - freqT) + v1 * freqT;
}
