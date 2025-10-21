import { useEffect, useRef, useState } from "react";
import { Box } from "@mantine/core";

interface AxisTransform {
  slope: number;
  offset: number;
}

interface CanvasChartProps {
  width: number; // Canvas width in px
  height: number; // Canvas height in px
  xTransform: AxisTransform; // Transform from canvas px to chart data coordinates
  yTransform: AxisTransform; // Transform from canvas px to chart data coordinates
  xOffset?: number; // Offset in chart data coordinates (default 0)
  onRender?: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
}

export function CanvasChart({
  width,
  height,
  xTransform,
  yTransform,
  xOffset = 0,
  onRender,
}: CanvasChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(
    null,
  );

  // Convert canvas px to chart data coordinates
  const canvasToChart = (canvasPx: number, transform: AxisTransform) => {
    return transform.slope * canvasPx + transform.offset;
  };

  // Convert chart data coordinates to canvas px
  const chartToCanvas = (chartValue: number, transform: AxisTransform) => {
    return (chartValue - transform.offset) / transform.slope;
  };

  // Calculate canvas x offset based on xOffset in chart coordinates
  const canvasXOffset = xOffset !== 0
    ? chartToCanvas(xOffset, xTransform) - chartToCanvas(0, xTransform)
    : 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size for high-DPI displays
    canvas.width = width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Call the render callback if provided
    if (onRender) {
      onRender(ctx, width, height);
    } else {
      // Default rendering: gradient with grid
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, "#228be6");
      gradient.addColorStop(1, "#15aabf");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
      ctx.lineWidth = 1;
      for (let i = 0; i < width; i += 50) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, height);
        ctx.stroke();
      }
      for (let i = 0; i < height; i += 50) {
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(width, i);
        ctx.stroke();
      }
    }
  }, [width, height, onRender]);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    // Adjust for canvas offset
    const adjustedCanvasX = canvasX - canvasXOffset;

    setMousePos({ x: adjustedCanvasX, y: canvasY });
  };

  const handleMouseLeave = () => {
    setMousePos(null);
  };

  return (
    <Box
      ref={containerRef}
      style={{
        width: "100%",
        height: height,
        overflow: "hidden",
        position: "relative",
        cursor: "crosshair",
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          position: "absolute",
          left: canvasXOffset,
          top: 0,
        }}
      />
      {mousePos && (
        <Box
          style={{
            position: "absolute",
            left: mousePos.x + 15,
            top: mousePos.y + 15,
            backgroundColor: "rgba(0, 0, 0, 0.8)",
            color: "white",
            padding: "8px 12px",
            borderRadius: "4px",
            fontSize: "12px",
            fontFamily: "monospace",
            pointerEvents: "none",
            whiteSpace: "nowrap",
            zIndex: 1000,
          }}
        >
          <div>Canvas: ({mousePos.x.toFixed(1)}px, {mousePos.y.toFixed(1)}px)</div>
          <div>
            Chart: ({canvasToChart(mousePos.x, xTransform).toFixed(2)}ms,{" "}
            {canvasToChart(mousePos.y, yTransform).toFixed(3)})
          </div>
        </Box>
      )}
    </Box>
  );
}
