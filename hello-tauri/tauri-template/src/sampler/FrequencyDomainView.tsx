import { Card, Group, Text, Stack, AngleSlider } from "@mantine/core";
import { CanvasChart } from "./CanvasChart.tsx";
import { useState, useCallback } from "react";
import { renderSpectrogram } from "./SpectrogramRenderer.tsx";

interface FrequencyDomainViewProps {
  canvasWidth: number; // Canvas width in px
  canvasHeight: number; // Canvas height in px
  timeRange: number; // Total time range in ms
  timeOffset: number; // Time offset in ms
}

export function FrequencyDomainView({
  canvasWidth,
  canvasHeight,
  timeRange,
  timeOffset,
}: FrequencyDomainViewProps) {
  const [numFreqBins, setNumFreqBins] = useState(256);
  const [numTimeBins, setNumTimeBins] = useState(512);

  // Coordinate system transforms
  // X-axis: Time range from timeOffset to timeOffset + timeRange (matches time domain view)
  // For x: chartValue = slope * canvasPx + offset
  // timeOffset = slope * 0 + offset -> offset = timeOffset
  // (timeOffset + timeRange) = slope * canvasWidth + offset
  // -> slope = timeRange / canvasWidth
  const xTransform = {
    slope: timeRange / canvasWidth,
    offset: timeOffset
  };

  // Y-axis: Frequency bins (logarithmic scale, but bins are also logarithmic)
  // Linear mapping: canvasY=0 -> highest frequency, canvasY=height -> lowest frequency
  // For simplicity, map to normalized frequency range [0, 1]
  // 0 = slope * 0 + offset -> offset = 0
  // 1 = slope * canvasHeight + offset -> slope = 1 / canvasHeight
  const yTransform = {
    slope: 1 / canvasHeight,
    offset: 0
  };

  // Convert frequency bins to angle (0-360 degrees)
  // Map 64 to 1024 bins -> 0 to 360 degrees
  const freqBinsToAngle = (bins: number) => ((bins - 64) / 960) * 360;
  const angleToFreqBins = (angle: number) => Math.round((angle / 360) * 960 + 64);

  // Convert time bins to angle (0-360 degrees)
  // Map 128 to 2048 bins -> 0 to 360 degrees
  const timeBinsToAngle = (bins: number) => ((bins - 128) / 1920) * 360;
  const angleToTimeBins = (angle: number) => Math.round((angle / 360) * 1920 + 128);

  // Render function wrapper for the spectrogram
  const handleRender = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    renderSpectrogram(ctx, width, height, {
      numFreqBins,
      numTimeBins,
      timeRange,
      timeOffset,
    });
  }, [numFreqBins, numTimeBins, timeRange, timeOffset]);

  return (
    <Card withBorder>
      <Card.Section>
        <CanvasChart
          width={canvasWidth}
          height={canvasHeight}
          xTransform={xTransform}
          yTransform={yTransform}
          xOffset={0}
          onRender={handleRender}
        />
      </Card.Section>
      <Card.Section p="md">
        <Group>
          <Stack align="center" gap="xs">
            <Text size="sm">Freq Bins</Text>
            <AngleSlider
              value={freqBinsToAngle(numFreqBins)}
              onChange={(angle) => setNumFreqBins(angleToFreqBins(angle))}
              size={40}
              color="violet"
              formatLabel={(angle) => `${angleToFreqBins(angle)}`}
            />
          </Stack>
          <Stack align="center" gap="xs">
            <Text size="sm">Time Bins</Text>
            <AngleSlider
              value={timeBinsToAngle(numTimeBins)}
              onChange={(angle) => setNumTimeBins(angleToTimeBins(angle))}
              size={40}
              color="pink"
              formatLabel={(angle) => `${angleToTimeBins(angle)}`}
            />
          </Stack>
        </Group>
      </Card.Section>
    </Card>
  );
}
