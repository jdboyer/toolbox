import { Card, Group, Text, Stack, AngleSlider } from "@mantine/core";
import { CanvasChart } from "./CanvasChart.tsx";
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface WavData {
  samples: number[];
  sample_rate: number;
  duration_ms: number;
}

interface TimeDomainViewProps {
  canvasWidth: number; // Canvas width in px
  canvasHeight: number; // Canvas height in px
  timeRange: number; // Total time range in ms
  timeOffset: number; // Time offset in ms
  onTimeRangeChange: (range: number) => void;
  onTimeOffsetChange: (offset: number) => void;
  wavFilePath: string | null;
}

export function TimeDomainView({
  canvasWidth,
  canvasHeight,
  timeRange,
  timeOffset,
  onTimeRangeChange,
  onTimeOffsetChange,
  wavFilePath,
}: TimeDomainViewProps) {
  const [wavData, setWavData] = useState<WavData | null>(null);

  // Load WAV file when path changes
  useEffect(() => {
    if (!wavFilePath) {
      setWavData(null);
      return;
    }

    const loadWavFile = async () => {
      try {
        console.log("Loading WAV file:", wavFilePath);
        const data = await invoke<WavData>("read_wav_file", { filePath: wavFilePath });
        console.log("WAV data loaded:", data);
        setWavData(data);
      } catch (error) {
        console.error("Failed to load WAV file:", error);
        setWavData(null);
      }
    };

    loadWavFile();
  }, [wavFilePath]);

  // Coordinate system transforms
  // X-axis: Time range from timeOffset to timeOffset + timeRange
  // For x: chartValue = slope * canvasPx + offset
  // timeOffset = slope * 0 + offset -> offset = timeOffset
  // (timeOffset + timeRange) = slope * canvasWidth + offset
  // -> slope = timeRange / canvasWidth
  const xTransform = {
    slope: timeRange / canvasWidth,
    offset: timeOffset
  };

  // For y: chartValue = slope * canvasPx + offset
  // 1 = slope * 0 + offset -> offset = 1
  // -1 = slope * 200 + offset -> -1 = slope * 200 + 1 -> slope = -0.01
  const yTransform = { slope: -0.01, offset: 1 };

  // Convert time range to angle (0-360 degrees)
  // Map 1000ms to 10000ms -> 0 to 360 degrees
  const rangeToAngle = (range: number) => ((range - 1000) / 9000) * 360;
  const angleToRange = (angle: number) => (angle / 360) * 9000 + 1000;

  // Convert time offset to angle (0-360 degrees)
  // Map -5000ms to 5000ms -> 0 to 360 degrees
  const offsetToAngle = (offset: number) => ((offset + 5000) / 10000) * 360;
  const angleToOffset = (angle: number) => (angle / 360) * 10000 - 5000;

  // Render function for the amplitude envelope
  const renderAmplitudeEnvelope = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
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
  }, [wavData, timeRange, timeOffset]);

  return (
    <Card withBorder>
      <Card.Section p="md">
        <Group>
          <Stack align="center" gap="xs">
            <Text size="sm">Zoom</Text>
            <AngleSlider
              value={rangeToAngle(timeRange)}
              onChange={(angle) => onTimeRangeChange(angleToRange(angle))}
              size={40}
              color="blue"
              formatLabel={(angle) => `${Math.round(angleToRange(angle))}ms`}
            />
          </Stack>
          <Stack align="center" gap="xs">
            <Text size="sm">Offset</Text>
            <AngleSlider
              value={offsetToAngle(timeOffset)}
              onChange={(angle) => onTimeOffsetChange(angleToOffset(angle))}
              size={40}
              color="green"
              formatLabel={(angle) => `${Math.round(angleToOffset(angle))}ms`}
            />
          </Stack>
        </Group>
      </Card.Section>
      <Card.Section>
        <CanvasChart
          width={canvasWidth}
          height={canvasHeight}
          xTransform={xTransform}
          yTransform={yTransform}
          xOffset={0}
          onRender={renderAmplitudeEnvelope}
        />
      </Card.Section>
    </Card>
  );
}
