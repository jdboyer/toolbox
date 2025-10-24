import { Card, Group, Text, Stack, AngleSlider } from "@mantine/core";
import { CanvasChart } from "./CanvasChart.tsx";
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { renderAmplitudeEnvelope } from "./AmplitudeEnvelopeRenderer.tsx";

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
  const [gain, setGain] = useState(1); // Gain from 1 to 5

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

  // Convert gain to angle (0-360 degrees)
  // Map 1 to 5 -> 0 to 360 degrees
  const gainToAngle = (g: number) => ((g - 1) / 4) * 360;
  const angleToGain = (angle: number) => (angle / 360) * 4 + 1;

  // Render function wrapper for the amplitude envelope
  const handleRender = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    renderAmplitudeEnvelope(ctx, width, height, {
      wavData,
      timeRange,
      timeOffset,
      gain,
    });
  }, [wavData, timeRange, timeOffset, gain]);

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
          <Stack align="center" gap="xs">
            <Text size="sm">Gain</Text>
            <AngleSlider
              value={gainToAngle(gain)}
              onChange={(angle) => setGain(angleToGain(angle))}
              size={40}
              color="orange"
              formatLabel={(angle) => `${angleToGain(angle).toFixed(1)}x`}
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
          onRender={handleRender}
        />
      </Card.Section>
    </Card>
  );
}
