import { Card, Group, Text, Stack, Slider, ColorInput } from "@mantine/core";
import { CanvasChart } from "./CanvasChart.tsx";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { renderSpectrogram, type SpectrogramData } from "./SpectrogramRenderer.tsx";
import { computeCQT } from "./cqt/cqt.ts";

interface WavData {
  samples: number[];
  sample_rate: number;
  duration_ms: number;
}

interface FrequencyDomainViewProps {
  canvasWidth: number; // Canvas width in px
  timeRange: number; // Total time range in ms
  timeOffset: number; // Time offset in ms
  wavFilePath: string | null;
  wavData: WavData | null;
}

export function FrequencyDomainView({
  canvasWidth,
  timeRange,
  timeOffset,
  wavFilePath,
  wavData,
}: FrequencyDomainViewProps) {
  console.log(`[FrequencyDomainView] Component render - timeOffset: ${timeOffset}, timeRange: ${timeRange}`);

  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasHeight, setCanvasHeight] = useState(400);

  // Measure container height on mount and resize
  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        // Reserve space for controls (approximately 250px) and card padding
        const availableHeight = rect.height - 280;
        setCanvasHeight(Math.max(200, availableHeight));
      }
    };

    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

  // CQT configuration parameters
  const [fmin, setFmin] = useState(65); // C2 - safe for 48kHz
  const [fmax, setFmax] = useState(4186); // C8
  const [binsPerOctave, setBinsPerOctave] = useState(12); // Semitone resolution
  const [hopLength, setHopLength] = useState(512);
  const [windowScale, setWindowScale] = useState(1.0);
  const [threshold, setThreshold] = useState(0.0054);

  // Colormap configuration (control points for gradient)
  const [color0, setColor0] = useState("#440154"); // Dark purple
  const [color1, setColor1] = useState("#3b528b"); // Blue
  const [color2, setColor2] = useState("#21918c"); // Teal
  const [color3, setColor3] = useState("#5ec962"); // Green
  const [color4, setColor4] = useState("#fde725"); // Yellow

  // Spectrogram state
  const [spectrogramData, setSpectrogramData] = useState<SpectrogramData | null>(null);
  const [isComputing, setIsComputing] = useState(false);

  // Compute CQT when WAV data or config changes
  useEffect(() => {
    if (!wavData) {
      setSpectrogramData(null);
      return;
    }

    const computeSpectrogramData = async () => {
      try {
        setIsComputing(true);
        console.log("Computing CQT with config:", { fmin, fmax, binsPerOctave, hopLength, windowScale, threshold });

        // Convert samples to Float32Array
        const audioData = new Float32Array(wavData.samples);

        // Compute CQT
        const result = await computeCQT(audioData, {
          sampleRate: wavData.sample_rate,
          fmin,
          fmax,
          binsPerOctave,
          hopLength,
          windowScale,
          threshold,
        });

        console.log(`CQT computed: ${result.numBins} bins × ${result.numFrames} frames`);

        // Find min/max magnitude for normalization
        let minMagnitude = Infinity;
        let maxMagnitude = -Infinity;
        for (let i = 0; i < result.magnitudes.length; i++) {
          minMagnitude = Math.min(minMagnitude, result.magnitudes[i]);
          maxMagnitude = Math.max(maxMagnitude, result.magnitudes[i]);
        }

        setSpectrogramData({
          magnitudes: result.magnitudes,
          numBins: result.numBins,
          numFrames: result.numFrames,
          minMagnitude,
          maxMagnitude,
          sampleRate: wavData.sample_rate,
          hopLength,
        });
      } catch (error) {
        console.error("Failed to compute CQT:", error);
        setSpectrogramData(null);
      } finally {
        setIsComputing(false);
      }
    };

    computeSpectrogramData();
  }, [wavData, fmin, fmax, binsPerOctave, hopLength, windowScale, threshold]);

  // Coordinate system transforms
  // X-axis: Time range from timeOffset to timeOffset + timeRange (matches time domain view)
  const xTransform = {
    slope: timeRange / canvasWidth,
    offset: timeOffset
  };

  // Y-axis: Frequency bins (logarithmic scale, but bins are also logarithmic)
  const yTransform = {
    slope: 1 / canvasHeight,
    offset: 0
  };

  // Memoize colormap array to avoid recreating it on every render
  const colormap = useMemo(() => [color0, color1, color2, color3, color4], [color0, color1, color2, color3, color4]);

  // Render function wrapper for the spectrogram
  const handleRender = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    renderSpectrogram(ctx, width, height, {
      spectrogramData,
      timeRange,
      timeOffset,
      colormap,
    });
  }, [spectrogramData, timeRange, timeOffset, colormap]);

  return (
    <Card withBorder ref={containerRef} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Card.Section style={{ flexShrink: 0 }}>
        <CanvasChart
          width={canvasWidth}
          height={canvasHeight}
          xTransform={xTransform}
          yTransform={yTransform}
          xOffset={0}
          onRender={handleRender}
        />
      </Card.Section>
      <Card.Section p="md" style={{ flexShrink: 0 }}>
        <Stack gap="md">
          <Group gap="xl" grow>
            <Stack gap="xs">
              <Group gap="xs">
                <div style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: isComputing ? '#fa5252' : '#51cf66',
                  flexShrink: 0,
                }} />
                <Text size="sm">fmin: {Math.round(fmin)} Hz</Text>
              </Group>
              <Slider
                value={fmin}
                onChange={setFmin}
                min={32.7}
                max={200}
                step={0.1}
                color="violet"
                label={(val) => `${Math.round(val)} Hz`}
              />
            </Stack>
            <Stack gap="xs">
              <Text size="sm">fmax: {Math.round(fmax)} Hz</Text>
              <Slider
                value={fmax}
                onChange={setFmax}
                min={1000}
                max={8000}
                step={1}
                color="pink"
                label={(val) => `${Math.round(val)} Hz`}
              />
            </Stack>
          </Group>
          <Group gap="xl" grow>
            <Stack gap="xs">
              <Text size="sm">Bins/Octave: {binsPerOctave}</Text>
              <Slider
                value={binsPerOctave}
                onChange={setBinsPerOctave}
                min={6}
                max={48}
                step={1}
                color="blue"
                label={(val) => `${val}`}
              />
            </Stack>
            <Stack gap="xs">
              <Text size="sm">Hop Length: {hopLength}</Text>
              <Slider
                value={hopLength}
                onChange={setHopLength}
                min={128}
                max={2048}
                step={1}
                color="cyan"
                label={(val) => `${val}`}
              />
            </Stack>
          </Group>
          <Group gap="xl" grow>
            <Stack gap="xs">
              <Text size="sm">Window Scale: {windowScale.toFixed(2)}x</Text>
              <Slider
                value={windowScale}
                onChange={setWindowScale}
                min={0.5}
                max={2.0}
                step={0.01}
                color="teal"
                label={(val) => `${val.toFixed(2)}x`}
              />
            </Stack>
            <Stack gap="xs">
              <Text size="sm">Threshold: {threshold.toFixed(4)}</Text>
              <Slider
                value={threshold}
                onChange={setThreshold}
                min={0.001}
                max={0.01}
                step={0.0001}
                color="green"
                label={(val) => `${val.toFixed(4)}`}
              />
            </Stack>
          </Group>
          <Group gap="xl" grow>
            <ColorInput
              label="Color 0 (Low)"
              value={color0}
              onChange={setColor0}
              format="hex"
            />
            <ColorInput
              label="Color 1"
              value={color1}
              onChange={setColor1}
              format="hex"
            />
            <ColorInput
              label="Color 2 (Mid)"
              value={color2}
              onChange={setColor2}
              format="hex"
            />
            <ColorInput
              label="Color 3"
              value={color3}
              onChange={setColor3}
              format="hex"
            />
            <ColorInput
              label="Color 4 (High)"
              value={color4}
              onChange={setColor4}
              format="hex"
            />
          </Group>
        </Stack>
      </Card.Section>
    </Card>
  );
}
