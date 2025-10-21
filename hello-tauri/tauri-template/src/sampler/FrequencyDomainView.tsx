import { Card, Group, Text } from "@mantine/core";
import { CanvasChart } from "./CanvasChart.tsx";

interface FrequencyDomainViewProps {
  timeRange: number; // Total time range in ms
  timeOffset: number; // Time offset in ms
}

export function FrequencyDomainView({
  timeRange,
  timeOffset,
}: FrequencyDomainViewProps) {
  // Canvas dimensions
  const canvasWidth = 800;
  const canvasHeight = 200;

  // Coordinate system transforms
  // X-axis: Time range from timeOffset to timeOffset + timeRange
  // For x: chartValue = slope * canvasPx + offset
  // timeOffset = slope * 0 + offset -> offset = timeOffset
  // (timeOffset + timeRange) = slope * canvasWidth + offset
  // -> slope = timeRange / canvasWidth
  const xTransform = {
    slope: timeRange / canvasWidth,
    offset: timeOffset
  };

  // For y: chartValue = slope * canvasPx + offset
  // 1 = slope * 0 + offset -> offset = 1
  // -1 = slope * 200 + offset -> -1 = slope * 200 + 1 -> slope = -0.01
  const yTransform = { slope: -0.01, offset: 1 };

  return (
    <Card withBorder>
      <Card.Section>
        <CanvasChart
          width={canvasWidth}
          height={canvasHeight}
          xTransform={xTransform}
          yTransform={yTransform}
          xOffset={0}
        />
      </Card.Section>
      <Card.Section p="md">
        <Group>
          <Text>Control A</Text>
          <Text>Control B</Text>
          <Text>Control C</Text>
        </Group>
      </Card.Section>
    </Card>
  );
}
