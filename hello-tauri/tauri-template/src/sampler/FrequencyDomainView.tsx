import { Card, Group, Text, Stack, Slider, RangeSlider, Tooltip } from "@mantine/core";
import { CanvasChart } from "./CanvasChart.tsx";
import { MagnitudeLegend } from "./MagnitudeLegend.tsx";
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
  color0: string;
  color1: string;
  color2: string;
  color3: string;
  color4: string;
  onTimeRangeChange?: (range: number) => void;
  onTimeOffsetChange?: (offset: number) => void;
}

export function FrequencyDomainView({
  canvasWidth,
  timeRange,
  timeOffset,
  wavFilePath,
  wavData,
  color0,
  color1,
  color2,
  color3,
  color4,
  onTimeRangeChange,
  onTimeOffsetChange,
}: FrequencyDomainViewProps) {
  //console.log(`[FrequencyDomainView] Component render - timeOffset: ${timeOffset}, timeRange: ${timeRange}`);

  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasHeight, setCanvasHeight] = useState(400);

  // Measure container height on mount and resize
  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        // Reserve space for controls (approximately 240px) and card padding
        const availableHeight = rect.height - 250;
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

  // Display controls
  const [gain, setGain] = useState(1.0);
  const [colorCurve, setColorCurve] = useState(1.0); // 0.1 to 10.0, where 1.0 is linear

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
        //console.log("Computing CQT with config:", { fmin, fmax, binsPerOctave, hopLength, windowScale, threshold });

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

        //console.log(`CQT computed: ${result.numBins} bins × ${result.numFrames} frames`);

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
      gain,
      colorCurve,
    });
  }, [spectrogramData, timeRange, timeOffset, colormap, gain, colorCurve]);

  // Tooltip renderer for the spectrogram
  const renderTooltip = useCallback((chartX: number, chartY: number) => {
    if (!spectrogramData || !wavData) {
      return <div>No data</div>;
    }

    // chartX is in milliseconds (timeOffset to timeOffset + timeRange)
    const timeMs = chartX;
    const timeSeconds = timeMs / 1000;

    // chartY is normalized bin position (0 to 1), but we need to invert it
    // because Y=0 is at the top of the canvas but represents the highest frequency
    // Convert canvas Y position to frequency bin
    const binFloat = (spectrogramData.numBins - 1) * (1 - chartY);
    const bin = Math.max(0, Math.min(spectrogramData.numBins - 1, Math.round(binFloat)));

    // Calculate frequency from bin index
    // Bins are logarithmically spaced from fmin to fmax
    const numOctaves = Math.log2(fmax / fmin);
    const octavePerBin = numOctaves / (spectrogramData.numBins - 1);
    const frequency = fmin * Math.pow(2, bin * octavePerBin);

    // Get magnitude at this position
    const frameFloat = timeSeconds / (spectrogramData.hopLength / spectrogramData.sampleRate);
    const frame = Math.max(0, Math.min(spectrogramData.numFrames - 1, Math.floor(frameFloat)));
    const magnitudeIndex = frame * spectrogramData.numBins + bin;
    const magnitude = spectrogramData.magnitudes[magnitudeIndex] ?? 0;

    return (
      <>
        <div>Time: {timeMs.toFixed(1)} ms</div>
        <div>Freq: {frequency.toFixed(1)} Hz</div>
        <div>Magnitude: {magnitude.toFixed(4)}</div>
      </>
    );
  }, [spectrogramData, wavData, fmin, fmax]);

  // Handle rectangle selection for zooming
  const handleRectangleSelect = useCallback((startX: number, startY: number, endX: number, endY: number) => {
    // startX and endX are in milliseconds (chart coordinates)
    // We only care about the X axis (time) for zooming

    const minTime = Math.min(startX, endX);
    const maxTime = Math.max(startX, endX);
    const newTimeRange = maxTime - minTime;

    // Only zoom if the range is meaningful (at least 10ms)
    if (newTimeRange >= 10) {
      if (onTimeRangeChange) {
        onTimeRangeChange(newTimeRange);
      }
      if (onTimeOffsetChange) {
        onTimeOffsetChange(minTime);
      }
    }
  }, [onTimeRangeChange, onTimeOffsetChange]);

  // Handle double-click to reset zoom to 5 seconds with offset 0
  const handleDoubleClick = useCallback(() => {
    if (onTimeRangeChange) {
      onTimeRangeChange(5000); // 5 seconds in milliseconds
    }
    if (onTimeOffsetChange) {
      onTimeOffsetChange(0);
    }
  }, [onTimeRangeChange, onTimeOffsetChange]);

  return (
    <Card withBorder ref={containerRef} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Card.Section style={{ flexShrink: 0, position: 'relative' }}>
        <CanvasChart
          width={canvasWidth}
          height={canvasHeight}
          xTransform={xTransform}
          yTransform={yTransform}
          xOffset={0}
          onRender={handleRender}
          renderTooltip={renderTooltip}
          enableDragSelection={true}
          onRectangleSelect={handleRectangleSelect}
          onDoubleClick={handleDoubleClick}
        />
        {spectrogramData && (
          <MagnitudeLegend
            width={80}
            height={Math.floor(canvasHeight / 3)}
            colormap={colormap}
            minMagnitude={spectrogramData.minMagnitude}
            maxMagnitude={spectrogramData.maxMagnitude}
            gain={gain}
            colorCurve={colorCurve}
          />
        )}
      </Card.Section>
      <Card.Section p="sm" style={{ flexShrink: 0 }}>
        <Stack gap="xs">
          {/* CQT Statistics */}
          <Group gap="md">
            <Group gap="xs">
              <div style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: isComputing ? '#fa5252' : '#51cf66',
                flexShrink: 0,
              }} />
              <Text size="xs" c="dimmed">
                {spectrogramData ? `${spectrogramData.numBins} bins × ${spectrogramData.numFrames} frames` : 'No data'}
              </Text>
            </Group>
            {spectrogramData && (
              <>
                <Text size="xs" c="dimmed">
                  Octaves: {Math.log2(fmax / fmin).toFixed(2)}
                </Text>
                <Text size="xs" c="dimmed">
                  Time res: {((hopLength / wavData!.sample_rate) * 1000).toFixed(1)}ms
                </Text>
                <Text size="xs" c="dimmed">
                  Freq res: {(1200 / binsPerOctave).toFixed(0)} cents
                </Text>
                <Text size="xs" c="dimmed">
                  Nyquist: {(wavData!.sample_rate / 2).toFixed(0)} Hz
                </Text>
              </>
            )}
          </Group>

          {/* Display Controls */}
          <Group gap="md" grow>
            <Tooltip label="Display gain: amplifies magnitude values before color mapping" withArrow>
              <Stack gap={2}>
                <Text size="xs" c="dimmed">Gain: {gain.toFixed(2)}x</Text>
                <Slider
                  value={gain}
                  onChange={setGain}
                  min={0.5}
                  max={10}
                  step={0.1}
                  color="orange"
                  size="xs"
                  label={(val) => `${val.toFixed(2)}x`}
                />
              </Stack>
            </Tooltip>
            <Tooltip label="Color curve: exponential mapping from magnitude to color (>1 = darker, <1 = brighter)" withArrow>
              <Stack gap={2}>
                <Text size="xs" c="dimmed">Color Curve: {colorCurve.toFixed(2)}</Text>
                <Slider
                  value={colorCurve}
                  onChange={setColorCurve}
                  min={0.1}
                  max={5.0}
                  step={0.1}
                  color="grape"
                  size="xs"
                  label={(val) => `${val.toFixed(2)}`}
                  marks={[
                    { value: 1.0, label: 'Linear' }
                  ]}
                />
              </Stack>
            </Tooltip>
          </Group>

          {/* CQT Controls */}
          <Tooltip label="Frequency range to analyze (lower and upper bounds of spectrogram)" withArrow>
            <Stack gap={2}>
              <Text size="xs" c="dimmed">Frequency Range: {Math.round(fmin)} Hz - {Math.round(fmax)} Hz</Text>
              <RangeSlider
                value={[fmin, fmax]}
                onChange={([newFmin, newFmax]) => {
                  setFmin(newFmin);
                  setFmax(newFmax);
                }}
                min={32.7}
                max={wavData ? wavData.sample_rate / 2 : 24000}
                step={0.1}
                color="violet"
                size="xs"
                label={(val) => `${Math.round(val)} Hz`}
                minRange={100}
              />
            </Stack>
          </Tooltip>
          <Group gap="md" grow>
            <Tooltip label="Number of frequency bins per octave (higher = finer pitch resolution)" withArrow>
              <Stack gap={2}>
                <Text size="xs" c="dimmed">Bins/Octave: {binsPerOctave}</Text>
                <Slider
                  value={binsPerOctave}
                  onChange={setBinsPerOctave}
                  min={6}
                  max={48}
                  step={1}
                  color="blue"
                  size="xs"
                  label={(val) => `${val}`}
                />
              </Stack>
            </Tooltip>
            <Tooltip label="Number of samples between frames (lower = finer time resolution but slower)" withArrow>
              <Stack gap={2}>
                <Text size="xs" c="dimmed">Hop Length: {hopLength}</Text>
                <Slider
                  value={hopLength}
                  onChange={setHopLength}
                  min={128}
                  max={2048}
                  step={1}
                  color="cyan"
                  size="xs"
                  label={(val) => `${val}`}
                />
              </Stack>
            </Tooltip>
          </Group>
          <Group gap="md" grow>
            <Tooltip label="Window size multiplier for frequency analysis (affects frequency resolution)" withArrow>
              <Stack gap={2}>
                <Text size="xs" c="dimmed">Window Scale: {windowScale.toFixed(2)}x</Text>
                <Slider
                  value={windowScale}
                  onChange={setWindowScale}
                  min={0.5}
                  max={2.0}
                  step={0.01}
                  color="teal"
                  size="xs"
                  label={(val) => `${val.toFixed(2)}x`}
                />
              </Stack>
            </Tooltip>
            <Tooltip label="Minimum magnitude threshold for display (filters out low-energy noise)" withArrow>
              <Stack gap={2}>
                <Text size="xs" c="dimmed">Threshold: {threshold.toFixed(4)}</Text>
                <Slider
                  value={threshold}
                  onChange={setThreshold}
                  min={0.001}
                  max={0.01}
                  step={0.0001}
                  color="green"
                  size="xs"
                  label={(val) => `${val.toFixed(4)}`}
                />
              </Stack>
            </Tooltip>
          </Group>
        </Stack>
      </Card.Section>
    </Card>
  );
}
