import { useEffect, useRef } from "react";
import { ScopeRenderer } from "./scope-renderer";

interface ScopeViewProps {
  canvasWidth: number;
  canvasHeight?: number;
}

export function ScopeView({ canvasWidth, canvasHeight = 400 }: ScopeViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ScopeRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const initRenderer = async () => {
      // Create and initialize the renderer
      const renderer = new ScopeRenderer();
      const initialized = await renderer.initialize(canvas);

      if (initialized) {
        rendererRef.current = renderer;
        renderer.startRendering();
      } else {
        console.error("Failed to initialize ScopeRenderer");
      }
    };

    initRenderer().catch(console.error);

    // Cleanup
    return () => {
      if (rendererRef.current) {
        rendererRef.current.destroy();
        rendererRef.current = null;
      }
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
