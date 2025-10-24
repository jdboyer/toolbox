interface WavData {
  samples: number[];
  sample_rate: number;
  duration_ms: number;
}

interface RenderParams {
  wavData: WavData | null;
  timeRange: number;
  timeOffset: number;
  gain: number;
}

interface GridConfig {
  intervalMs: number;
  labelFormat: (timeMs: number) => string;
}

// Determine optimal grid spacing based on visible time range
function getGridConfig(timeRangeMs: number, canvasWidth: number): GridConfig {
  // Calculate how many pixels per second
  const pxPerSecond = canvasWidth / (timeRangeMs / 1000);

  // We want at least 80px between grid lines for readability
  const minPxBetweenLines = 80;

  console.log('getGridConfig called:', { timeRangeMs, canvasWidth, pxPerSecond, minPxBetweenLines });

  // Possible intervals: 10ms, 20ms, 50ms, 100ms, 200ms, 500ms, 1s (smallest to largest)
  const intervals = [
    { ms: 10, format: (t: number) => `${t.toFixed(0)}ms` },
    { ms: 20, format: (t: number) => `${t.toFixed(0)}ms` },
    { ms: 50, format: (t: number) => `${t.toFixed(0)}ms` },
    { ms: 100, format: (t: number) => `${t.toFixed(0)}ms` },
    { ms: 200, format: (t: number) => `${t.toFixed(0)}ms` },
    { ms: 500, format: (t: number) => `${(t / 1000).toFixed(1)}s` },
    { ms: 1000, format: (t: number) => `${(t / 1000).toFixed(0)}s` },
  ];

  // Find the smallest interval that gives us enough spacing
  // Iterate from largest to smallest, return the first one that's too small
  // (meaning the previous one was the smallest that works)
  let selectedInterval = intervals[intervals.length - 1]; // Default to largest (1000ms)

  for (let i = intervals.length - 1; i >= 0; i--) {
    const interval = intervals[i];
    const pxBetweenLines = (interval.ms / 1000) * pxPerSecond;
    console.log(`Testing interval ${interval.ms}ms: pxBetweenLines=${pxBetweenLines}`);
    if (pxBetweenLines >= minPxBetweenLines) {
      selectedInterval = interval;
      console.log(`Candidate interval: ${interval.ms}ms`);
      // Keep going to find smaller intervals
    } else {
      // This interval is too small, stop here
      console.log(`Interval ${interval.ms}ms too small, stopping`);
      break;
    }
  }

  console.log(`Final selected interval: ${selectedInterval.ms}ms`);
  return {
    intervalMs: selectedInterval.ms,
    labelFormat: selectedInterval.format,
  };
}

// Draw grid lines and labels
function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  timeRange: number,
  timeOffset: number
) {
  const config = getGridConfig(timeRange, width);

  console.log('Grid config:', {
    timeRange,
    width,
    intervalMs: config.intervalMs,
    pxPerSecond: width / (timeRange / 1000),
  });

  // Calculate the first grid line position (snap to interval)
  const firstGridTime = Math.ceil(timeOffset / config.intervalMs) * config.intervalMs;

  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
  ctx.font = "11px monospace";
  ctx.textBaseline = "top";

  // Draw vertical grid lines
  for (let timeMs = firstGridTime; timeMs <= timeOffset + timeRange; timeMs += config.intervalMs) {
    // Calculate x position in canvas
    const x = ((timeMs - timeOffset) / timeRange) * width;

    if (x >= 0 && x <= width) {
      // Draw vertical line
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      // Draw label at top
      const label = config.labelFormat(timeMs);
      const labelWidth = ctx.measureText(label).width;

      // Position label slightly to the right of the line, unless near the edge
      let labelX = x + 4;
      if (labelX + labelWidth > width) {
        labelX = x - labelWidth - 4;
      }

      ctx.fillText(label, labelX, 4);
    }
  }
}

export function renderAmplitudeEnvelope(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  params: RenderParams
) {
  const { wavData, timeRange, timeOffset, gain } = params;

  // Clear background
  ctx.fillStyle = "#1a1b1e";
  ctx.fillRect(0, 0, width, height);

  // Draw grid first (so it's behind the waveform)
  drawGrid(ctx, width, height, timeRange, timeOffset);

  if (!wavData || !wavData.samples || wavData.samples.length === 0) {
    // No data to render, just show the grid
    return;
  }

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

      // Apply gain and clamp to [0, 1]
      const scaledMagnitude = Math.min(1, avgMagnitude * gain);

      // Map magnitude [0, 1] to canvas y-coordinate
      // 0 magnitude = midY (center), max magnitude extends to top
      const y = midY - (scaledMagnitude * midY);
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

      // Apply gain and clamp to [0, 1]
      const scaledMagnitude = Math.min(1, avgMagnitude * gain);

      // Map magnitude [0, 1] to canvas y-coordinate
      // 0 magnitude = midY (center), max magnitude extends to bottom
      const y = midY + (scaledMagnitude * midY);
      ctx.lineTo(px, y);
    } else {
      ctx.lineTo(px, midY);
    }
  }

  ctx.closePath();
  ctx.fill();

  // Draw center line for amplitude reference
  ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(width, midY);
  ctx.stroke();
}
