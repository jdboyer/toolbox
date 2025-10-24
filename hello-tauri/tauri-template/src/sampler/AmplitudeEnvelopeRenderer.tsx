interface WavData {
  samples: number[];
  sample_rate: number;
  duration_ms: number;
}

interface RenderParams {
  wavData: WavData | null;
  timeRange: number;
  timeOffset: number;
}

export function renderAmplitudeEnvelope(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  params: RenderParams
) {
  const { wavData, timeRange, timeOffset } = params;

  if (!wavData || !wavData.samples || wavData.samples.length === 0) {
    // Draw default gradient if no data
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#228be6");
    gradient.addColorStop(1, "#15aabf");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    return;
  }

  // Clear background
  ctx.fillStyle = "#1a1b1e";
  ctx.fillRect(0, 0, width, height);

  // Calculate time per pixel
  const msPerPixel = timeRange / width;
  const startTimeMs = timeOffset;
  const endTimeMs = timeOffset + timeRange;

  // Calculate sample indices for the visible time range
  const sampleRate = wavData.sample_rate;
  const startSampleIndex = Math.max(0, Math.floor((startTimeMs / 1000) * sampleRate));
  const endSampleIndex = Math.min(wavData.samples.length, Math.ceil((endTimeMs / 1000) * sampleRate));

  // Calculate window size for envelope (adaptive based on zoom level)
  const samplesPerPixel = (sampleRate * msPerPixel) / 1000;
  const windowSize = Math.max(1, Math.floor(samplesPerPixel));

  // Draw the amplitude envelope as a filled shape
  ctx.fillStyle = "#228be6";
  ctx.beginPath();

  const midY = height / 2;

  // Start from middle-left
  ctx.moveTo(0, midY);

  // Draw top half of envelope (positive/upward)
  for (let px = 0; px < width; px++) {
    const timeMs = startTimeMs + (px * msPerPixel);
    const centerSampleIndex = Math.floor((timeMs / 1000) * sampleRate);

    if (centerSampleIndex >= startSampleIndex && centerSampleIndex < endSampleIndex) {
      // Calculate average magnitude in the window around this pixel
      const windowStart = Math.max(startSampleIndex, centerSampleIndex - Math.floor(windowSize / 2));
      const windowEnd = Math.min(endSampleIndex, centerSampleIndex + Math.ceil(windowSize / 2));

      let sumMagnitude = 0;
      let count = 0;
      for (let i = windowStart; i < windowEnd; i++) {
        sumMagnitude += Math.abs(wavData.samples[i]);
        count++;
      }

      const avgMagnitude = count > 0 ? sumMagnitude / count : 0;

      // Map magnitude [0, 1] to canvas y-coordinate
      // 0 magnitude = midY (center), max magnitude extends to top
      const y = midY - (avgMagnitude * midY);
      ctx.lineTo(px, y);
    } else {
      ctx.lineTo(px, midY);
    }
  }

  // Draw bottom half of envelope (return path, symmetric)
  for (let px = width - 1; px >= 0; px--) {
    const timeMs = startTimeMs + (px * msPerPixel);
    const centerSampleIndex = Math.floor((timeMs / 1000) * sampleRate);

    if (centerSampleIndex >= startSampleIndex && centerSampleIndex < endSampleIndex) {
      // Calculate average magnitude in the window around this pixel
      const windowStart = Math.max(startSampleIndex, centerSampleIndex - Math.floor(windowSize / 2));
      const windowEnd = Math.min(endSampleIndex, centerSampleIndex + Math.ceil(windowSize / 2));

      let sumMagnitude = 0;
      let count = 0;
      for (let i = windowStart; i < windowEnd; i++) {
        sumMagnitude += Math.abs(wavData.samples[i]);
        count++;
      }

      const avgMagnitude = count > 0 ? sumMagnitude / count : 0;

      // Map magnitude [0, 1] to canvas y-coordinate
      // 0 magnitude = midY (center), max magnitude extends to bottom
      const y = midY + (avgMagnitude * midY);
      ctx.lineTo(px, y);
    } else {
      ctx.lineTo(px, midY);
    }
  }

  ctx.closePath();
  ctx.fill();

  // Draw center line
  ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(width, midY);
  ctx.stroke();
}
