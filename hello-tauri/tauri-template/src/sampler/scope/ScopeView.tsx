import { useEffect, useRef } from "react";
import AnalyzerService from "./analyzer-service";

interface ScopeViewProps {
  canvasWidth: number;
  canvasHeight?: number;
}

export function ScopeView({ canvasWidth, canvasHeight = 400 }: ScopeViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const initRenderer = async () => {
      // Get the analyzer instance
      const analyzer = await AnalyzerService.getAnalyzer();
      if (!analyzer) {
        console.error("Failed to get Analyzer instance");
        return;
      }

      // Initialize the analyzer with the canvas
      const initialized = await analyzer.initialize(canvas);

      if (initialized) {
        analyzer.startRendering();
      } else {
        console.error("Failed to initialize SimpleAnalyzer");
      }
    };

    initRenderer().catch(console.error);

    // Cleanup - the renderer is owned by the analyzer and will be cleaned up when it's destroyed
    return () => {
      // We don't destroy the renderer here since it's owned by the analyzer
      // The analyzer service manages the lifecycle
    };
  }, [canvasWidth, canvasHeight]);

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
