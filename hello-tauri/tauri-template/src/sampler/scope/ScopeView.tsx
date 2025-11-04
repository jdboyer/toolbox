import { useEffect, useRef } from "react";
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
      // uvScale.x: What fraction of the texture to display (0-1+)
      //   - If timeRange < totalDuration, we zoom IN (show less of texture, smaller scale)
      //   - If timeRange > totalDuration, we zoom OUT (show more of texture, larger scale)
      const uvScaleX = timeRange / totalDurationMs;

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
  }, [timeRange, timeOffset, sampleRate]);

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
