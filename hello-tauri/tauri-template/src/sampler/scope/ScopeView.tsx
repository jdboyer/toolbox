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
      const hopLength = transformer.getHopLength();

      // Calculate texture dimensions and time mapping
      const textureWidth = spectrogram.getTextureWidth();
      const totalDurationMs = (textureWidth * hopLength / sampleRate) * 1000;

      // Calculate UV scale and offset
      // uvScale.x controls how much of the texture we show (zoom)
      // uvOffset.x controls which part of the texture we start from (pan)
      const uvScaleX = totalDurationMs / timeRange; // How much texture to show
      const uvOffsetX = timeOffset / totalDurationMs; // Where to start in the texture

      // Y-axis: show full frequency range (no zoom)
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
