import { Card, Group, Text } from "@mantine/core";
import { useEffect, useRef } from "react";

export function TimeDomainView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size to match display size
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    // Draw a gradient pattern to visualize the canvas
    const gradient = ctx.createLinearGradient(0, 0, rect.width, rect.height);
    gradient.addColorStop(0, "#228be6");
    gradient.addColorStop(1, "#15aabf");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, rect.width, rect.height);

    // Draw a grid pattern
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = 1;
    for (let i = 0; i < rect.width; i += 50) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, rect.height);
      ctx.stroke();
    }
    for (let i = 0; i < rect.height; i += 50) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(rect.width, i);
      ctx.stroke();
    }
  }, []);

  return (
    <Card withBorder>
      <Card.Section p="md">
        <Group>
          <Text>Control A</Text>
          <Text>Control B</Text>
          <Text>Control C</Text>
        </Group>
      </Card.Section>
      <Card.Section>
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "300px", display: "block" }}
        />
      </Card.Section>
    </Card>
  );
}
