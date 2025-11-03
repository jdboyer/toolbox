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

  // TODO: Add zoom/pan controls using timeRange, timeOffset, sampleRate

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
