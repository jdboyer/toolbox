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
  renderTooltip?: (chartX: number, chartY: number) => React.ReactNode; // Custom tooltip renderer
  enableDragSelection?: boolean; // Enable drag to select rectangle
  onRectangleSelect?: (startX: number, startY: number, endX: number, endY: number) => void; // Called when rectangle selection is complete (in chart coordinates)
  onDoubleClick?: (chartX: number, chartY: number) => void; // Called when double-clicking on the canvas (in chart coordinates)
}

export function CanvasChart({
  width,
  height,
  xTransform,
  yTransform,
  xOffset = 0,
  onRender,
  renderTooltip,
  enableDragSelection = false,
  onRectangleSelect,
  onDoubleClick,
}: CanvasChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [dragEnd, setDragEnd] = useState<{ x: number; y: number } | null>(
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
    const effectStart = performance.now();
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
      const renderStart = performance.now();
      ctx.save();
      onRender(ctx, width, height);
      ctx.restore();
      const renderEnd = performance.now();
      console.log(`[CanvasChart] Effect setup: ${(renderStart - effectStart).toFixed(2)}ms, Render callback: ${(renderEnd - renderStart).toFixed(2)}ms, Total: ${(renderEnd - effectStart).toFixed(2)}ms`);
    } else {
      // Default rendering: gradient with grid that shows the time range
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, "#228be6");
      gradient.addColorStop(1, "#15aabf");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      // Draw grid based on chart coordinates
      ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
      ctx.lineWidth = 1;

      // Vertical grid lines every 500ms in chart coordinates
      const startTime = canvasToChart(0, xTransform);
      const endTime = canvasToChart(width, xTransform);
      const timeStep = 500; // 500ms

      for (let time = Math.ceil(startTime / timeStep) * timeStep; time <= endTime; time += timeStep) {
        const x = chartToCanvas(time, xTransform);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      // Horizontal grid lines every 0.25 units in chart coordinates
      const topValue = canvasToChart(0, yTransform);
      const bottomValue = canvasToChart(height, yTransform);
      const valueStep = 0.25;

      for (let value = Math.ceil(bottomValue / valueStep) * valueStep; value <= topValue; value += valueStep) {
        const y = chartToCanvas(value, yTransform);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    }
  }, [width, height, onRender, xTransform, yTransform]);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!enableDragSelection) return;

    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    // Adjust for canvas offset
    const adjustedCanvasX = canvasX - canvasXOffset;

    setDragStart({ x: adjustedCanvasX, y: canvasY });
    setDragEnd(null);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    // Adjust for canvas offset
    const adjustedCanvasX = canvasX - canvasXOffset;

    setMousePos({ x: adjustedCanvasX, y: canvasY });

    // Update drag end position if dragging
    if (enableDragSelection && dragStart) {
      setDragEnd({ x: adjustedCanvasX, y: canvasY });
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!enableDragSelection || !dragStart) return;

    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    // Adjust for canvas offset
    const adjustedCanvasX = canvasX - canvasXOffset;

    // Convert to chart coordinates
    const startChartX = canvasToChart(dragStart.x, xTransform);
    const startChartY = canvasToChart(dragStart.y, yTransform);
    const endChartX = canvasToChart(adjustedCanvasX, xTransform);
    const endChartY = canvasToChart(canvasY, yTransform);

    // Call callback with rectangle coordinates
    if (onRectangleSelect) {
      onRectangleSelect(startChartX, startChartY, endChartX, endChartY);
    }

    // Clear drag state
    setDragStart(null);
    setDragEnd(null);
  };

  const handleMouseLeave = () => {
    setMousePos(null);
    // Clear drag on mouse leave
    if (enableDragSelection) {
      setDragStart(null);
      setDragEnd(null);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onDoubleClick) return;

    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    // Adjust for canvas offset
    const adjustedCanvasX = canvasX - canvasXOffset;

    // Convert to chart coordinates
    const chartX = canvasToChart(adjustedCanvasX, xTransform);
    const chartY = canvasToChart(canvasY, yTransform);

    // Call callback with chart coordinates
    onDoubleClick(chartX, chartY);
  };

  return (
    <Box
      ref={containerRef}
      style={{
        width: "100%",
        height: height,
        overflow: "hidden",
        position: "relative",
        cursor: enableDragSelection ? "crosshair" : "default",
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      onDoubleClick={handleDoubleClick}
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
      {/* Drag selection rectangle overlay */}
      {enableDragSelection && dragStart && dragEnd && (
        <Box
          style={{
            position: "absolute",
            left: Math.min(dragStart.x, dragEnd.x),
            top: Math.min(dragStart.y, dragEnd.y),
            width: Math.abs(dragEnd.x - dragStart.x),
            height: Math.abs(dragEnd.y - dragStart.y),
            backgroundColor: "rgba(255, 255, 255, 0.05)",
            border: "1px solid rgba(255, 255, 255, 0.25)",
            pointerEvents: "none",
          }}
        />
      )}
      {mousePos && !dragStart && (
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
          {renderTooltip ? (
            renderTooltip(
              canvasToChart(mousePos.x, xTransform),
              canvasToChart(mousePos.y, yTransform)
            )
          ) : (
            <>
              <div>Canvas: ({mousePos.x.toFixed(1)}px, {mousePos.y.toFixed(1)}px)</div>
              <div>
                Chart: ({canvasToChart(mousePos.x, xTransform).toFixed(2)}ms,{" "}
                {canvasToChart(mousePos.y, yTransform).toFixed(3)})
              </div>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}
