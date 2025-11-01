import { useEffect, useRef } from "react";
import { Box } from "@mantine/core";

interface MagnitudeLegendProps {
  width: number;
  height: number;
  colormap: string[];
  minMagnitude: number;
  maxMagnitude: number;
  gain: number;
  colorCurve: number;
}

// Convert hex color to RGB
function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)]
    : [0, 0, 0];
}

// Convert magnitude (0-1) to RGB color using a configurable colormap
function magnitudeToColor(magnitude: number, colormap: string[]): [number, number, number] {
  const m = Math.max(0, Math.min(1, magnitude));

  const controlPoints: [number, number, number, number][] = colormap.map((hexColor, index) => {
    const [r, g, b] = hexToRgb(hexColor);
    const magnitude = index / (colormap.length - 1);
    return [magnitude, r, g, b];
  });

  let lowerIdx = 0;
  for (let i = 0; i < controlPoints.length - 1; i++) {
    if (m >= controlPoints[i][0] && m <= controlPoints[i + 1][0]) {
      lowerIdx = i;
      break;
    }
  }

  const lower = controlPoints[lowerIdx];
  const upper = controlPoints[lowerIdx + 1];
  const t = (m - lower[0]) / (upper[0] - lower[0]);

  const r = Math.round(lower[1] + (upper[1] - lower[1]) * t);
  const g = Math.round(lower[2] + (upper[2] - lower[2]) * t);
  const b = Math.round(lower[3] + (upper[3] - lower[3]) * t);

  return [r, g, b];
}

// Convert magnitude to dB
function magnitudeToDB(magnitude: number): number {
  if (magnitude <= 0) return -100; // Floor at -100 dB
  return 20 * Math.log10(magnitude);
}

export function MagnitudeLegend({
  width,
  height,
  colormap,
  minMagnitude,
  maxMagnitude,
  gain,
  colorCurve,
}: MagnitudeLegendProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

    // Layout parameters
    const tickLength = 5;
    const labelOffset = 8;
    const gradientWidth = 10; // Half of original 20px
    const leftMargin = 5;
    const rightMargin = 15; // Increased to move legend left
    const topMargin = 10;
    const bottomMargin = 10;

    const gradientX = width - rightMargin - gradientWidth; // Position on right side
    const gradientHeight = height - topMargin - bottomMargin;
    const gradientY = topMargin;

    // Normalize magnitude with gain and curve (same as renderer)
    const magRange = maxMagnitude - minMagnitude;
    const normalizeMagnitude = (mag: number) => {
      if (magRange === 0) return 0;
      const gainedMag = mag * gain;
      // Apply gain to the range as well for consistent normalization
      const gainedMin = minMagnitude * gain;
      const gainedRange = magRange * gain;
      const normalized = Math.max(0, Math.min(1, (gainedMag - gainedMin) / gainedRange));
      return Math.pow(normalized, 1 / colorCurve);
    };

    // Draw color gradient using logarithmic scale (dB is already logarithmic)
    // Map dB linearly to Y position for even spacing
    const minDB = magnitudeToDB(minMagnitude);
    const maxDB = magnitudeToDB(maxMagnitude);
    const dbRange = maxDB - minDB;

    for (let y = 0; y < gradientHeight; y++) {
      // Map y position to dB linearly (0 at top = maxDB, gradientHeight at bottom = minDB)
      const t = y / gradientHeight; // 0 to 1 (top to bottom)
      const db = maxDB - t * dbRange; // Linear in dB space

      // Convert dB back to linear magnitude
      const rawMagnitude = Math.pow(10, db / 20);
      const normalizedMag = normalizeMagnitude(rawMagnitude);
      const [r, g, b] = magnitudeToColor(normalizedMag, colormap);

      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(gradientX, gradientY + y, gradientWidth, 1);
    }

    // Draw border around gradient with 50% transparency
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(gradientX, gradientY, gradientWidth, gradientHeight);

    // Draw Y-axis tick marks and labels in dB
    // Calculate nice tick intervals
    let tickInterval: number;
    if (dbRange > 80) {
      tickInterval = 20;
    } else if (dbRange > 40) {
      tickInterval = 10;
    } else if (dbRange > 20) {
      tickInterval = 5;
    } else {
      tickInterval = 2;
    }

    // Start from a nice round number
    const startDB = Math.ceil(minDB / tickInterval) * tickInterval;

    ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let db = startDB; db <= maxDB; db += tickInterval) {
      // Map dB linearly to Y position (since we're using logarithmic scale)
      const t = (maxDB - db) / dbRange; // 0 at top (maxDB), 1 at bottom (minDB)
      const y = gradientY + t * gradientHeight;

      if (y >= gradientY && y <= gradientY + gradientHeight) {
        // Draw tick mark to the left of the gradient
        ctx.beginPath();
        ctx.moveTo(gradientX, y);
        ctx.lineTo(gradientX - tickLength, y);
        ctx.stroke();

        // Draw label to the left of tick mark
        ctx.fillText(`${db.toFixed(0)} dB`, gradientX - tickLength - labelOffset, y);
      }
    }

  }, [width, height, colormap, minMagnitude, maxMagnitude, gain, colorCurve]);

  return (
    <Box
      style={{
        position: "absolute",
        right: 0,
        top: 0,
        width,
        height,
        pointerEvents: "none",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
        }}
      />
    </Box>
  );
}
