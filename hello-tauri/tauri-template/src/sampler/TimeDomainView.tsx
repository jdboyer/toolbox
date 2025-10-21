import { Card, Group, Text } from "@mantine/core";
import { CanvasChart } from "./CanvasChart.tsx";

export function TimeDomainView() {
  // Canvas dimensions
  const canvasWidth = 800;
  const canvasHeight = 200;

  // Coordinate system transforms
  // X-axis: (0px, 0px) = (-1000ms, 1 unit) and (800px, 200px) = (3000ms, -1 unit)
  // For x: chartValue = slope * canvasPx + offset
  // -1000 = slope * 0 + offset -> offset = -1000
  // 3000 = slope * 800 + offset -> 3000 = slope * 800 - 1000 -> slope = 5
  const xTransform = { slope: 5, offset: -1000 };

  // For y: chartValue = slope * canvasPx + offset
  // 1 = slope * 0 + offset -> offset = 1
  // -1 = slope * 200 + offset -> -1 = slope * 200 + 1 -> slope = -0.01
  const yTransform = { slope: -0.01, offset: 1 };

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
        <CanvasChart
          width={canvasWidth}
          height={canvasHeight}
          xTransform={xTransform}
          yTransform={yTransform}
          xOffset={0}
        />
      </Card.Section>
    </Card>
  );
}
