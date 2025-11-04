import { useEffect, useRef, useState } from "react";
import AnalyzerService from "./analyzer-service";

interface ScopeViewProps {
  canvasWidth: number;
  canvasHeight?: number;
  timeRange: number;
  timeOffset: number;
  sampleRate: number;
}

export function ScopeView({ canvasWidth, canvasHeight = 400, timeRange, timeOffset, sampleRate }: ScopeViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyzerRef = useRef<any>(null);
  const [renderedWidth, setRenderedWidth] = useState<number>(canvasWidth);

  // Track the actual rendered canvas width (after CSS scaling)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateRenderedWidth = () => {
      const rect = canvas.getBoundingClientRect();
      setRenderedWidth(rect.width);
    };

    // Initial measurement
    updateRenderedWidth();

    // Track resize
    const resizeObserver = new ResizeObserver(updateRenderedWidth);
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Initialize renderer once
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let animationFrameId: number | null = null;

    const initRenderer = async () => {
      // Get the analyzer instance
      const analyzer = await AnalyzerService.getAnalyzer();
      if (!analyzer) {
        console.error("Failed to get Analyzer instance");
        return;
      }

      analyzerRef.current = analyzer;

      // Initialize the scope renderer with the canvas
      const initialized = analyzer.initializeScopeRenderer(canvas);

      if (initialized) {
        const renderer = analyzer.getScopeRenderer();
        if (renderer) {
          // Start continuous rendering
          const render = () => {
            renderer.render();
            animationFrameId = requestAnimationFrame(render);
          };
          render();
        }
      } else {
        console.error("Failed to initialize ScopeRenderer");
      }
    };

    initRenderer().catch(console.error);

    // Cleanup
    return () => {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [canvasWidth, canvasHeight]);

  // Update UV transform when timeRange or timeOffset changes
  useEffect(() => {
    const updateUVTransform = async () => {
      const analyzer = analyzerRef.current || await AnalyzerService.getAnalyzer();
      if (!analyzer) return;

      const renderer = analyzer.getScopeRenderer();
      if (!renderer) return;

      // Get transformer to access timing information
      const transformer = analyzer.getTransformer();
      const spectrogram = transformer.getSpectrogram();
      const config = transformer.getConfig();
      const batchFactor = transformer.getBatchFactor();

      // Calculate frame-to-time ratio
      // hopLength = blockSize / batchFactor (samples per frame)
      const hopLength = config.blockSize / batchFactor;
      const msPerFrame = (hopLength / sampleRate) * 1000;

      // Calculate texture dimensions and total duration
      const textureWidth = spectrogram.getTextureWidth();
      const totalDurationMs = textureWidth * msPerFrame;

      // Calculate UV scale and offset
      // The timeRange determines how much time is displayed across the rendered canvas width
      //
      // In TimeDomainView:
      //   - Fixed canvas of 1400px shows timeRange ms
      //   - Pixel density: 1400 / timeRange (pixels per ms)
      //
      // In ScopeView:
      //   - Rendered canvas of renderedWidth shows some portion of texture
      //   - Texture has textureWidth frames representing totalDurationMs
      //   - We want the same pixel density as TimeDomainView
      //
      // To match pixel densities:
      //   renderedWidth / displayedTime = 1400 / timeRange
      //   displayedTime = (renderedWidth * timeRange) / 1400
      //
      // uvScale = displayedTime / totalDurationMs
      const displayedTimeMs = (renderedWidth * timeRange) / 1400;
      const uvScaleX = displayedTimeMs / totalDurationMs;

      // uvOffset.x: Which part of the texture to start from (normalized 0-1)
      const uvOffsetX = timeOffset / totalDurationMs;

      // Y-axis: show full frequency range (no zoom/pan)
      const uvScaleY = 1.0;
      const uvOffsetY = 0.0;

      renderer.setUVTransform(
        [uvScaleX, uvScaleY],
        [uvOffsetX, uvOffsetY]
      );
    };

    updateUVTransform().catch(console.error);
  }, [timeRange, timeOffset, sampleRate, renderedWidth]);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <canvas
        ref={canvasRef}
        width={canvasWidth}
        height={canvasHeight}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          imageRendering: "pixelated",
        }}
      />
    </div>
  );
}
