import { Stack, Group, ActionIcon, Text } from "@mantine/core";
import { IconFolder } from "@tabler/icons-react";
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { TimeDomainView } from "./TimeDomainView";
import { FrequencyDomainView } from "./FrequencyDomainView";

export function Sampler() {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // Canvas dimensions
  const canvasWidth = 1400;
  const timeDomainHeight = 100;
  const frequencyDomainHeight = 400;

  // Time axis state (in milliseconds)
  const [timeRange, setTimeRange] = useState(4000); // Total time range visible (ms)
  const [timeOffset, setTimeOffset] = useState(0); // Time offset from 0 (ms)

  const handleSelectFile = async () => {
    console.log("handleSelectFile called");
    try {
      console.log("About to open dialog...");
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'Audio',
          extensions: ['wav', 'mp3', 'flac', 'ogg', 'aiff', 'aac']
        }]
      });

      console.log("Dialog result:", selected);
      if (selected && typeof selected === 'string') {
        setSelectedFile(selected);
        console.log("File selected:", selected);
      }
    } catch (error) {
      console.error("Failed to open file dialog:", error);
    }
  };

  const getFileName = () => {
    if (!selectedFile) return "No sample selected.";
    const filename = selectedFile.split(/[\\/]/).pop() || "";
    return filename.replace(/\.[^/.]+$/, ""); // Remove extension
  };

  return (
    <Stack style={{ width: '100%', height: '100%' }} gap="md">
      <Group>
        <ActionIcon onClick={handleSelectFile} variant="default" size="lg">
          <IconFolder size={18} />
        </ActionIcon>
        <Text>{getFileName()}</Text>
      </Group>

      <TimeDomainView
        canvasWidth={canvasWidth}
        canvasHeight={timeDomainHeight}
        timeRange={timeRange}
        timeOffset={timeOffset}
        onTimeRangeChange={setTimeRange}
        onTimeOffsetChange={setTimeOffset}
      />

      <FrequencyDomainView
        canvasWidth={canvasWidth}
        canvasHeight={frequencyDomainHeight}
        timeRange={timeRange}
        timeOffset={timeOffset}
      />
    </Stack>
  );
}
