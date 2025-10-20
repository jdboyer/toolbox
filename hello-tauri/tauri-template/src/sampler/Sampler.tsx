import { Paper, Stack, Group, ActionIcon, Text } from "@mantine/core";
import { IconFolder } from "@tabler/icons-react";
import { useState } from "react";
import { TimeDomainView } from "./TimeDomainView";
import { FrequencyDomainView } from "./FrequencyDomainView";

export function Sampler() {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const handleSelectFile = async () => {
    // TODO: Implement file dialog using Tauri's dialog plugin
    // For now, this is a placeholder
    console.log("Open file dialog");
  };

  const getFileName = () => {
    if (!selectedFile) return "No sample selected.";
    const filename = selectedFile.split(/[\\/]/).pop() || "";
    return filename.replace(/\.[^/.]+$/, ""); // Remove extension
  };

  return (
    <Paper p="md" withBorder style={{ height: '100%' }}>
      <Stack style={{ width: '100%' }} gap="md">
        <Group>
          <ActionIcon onClick={handleSelectFile} variant="default" size="lg">
            <IconFolder size={18} />
          </ActionIcon>
          <Text>{getFileName()}</Text>
        </Group>

        <TimeDomainView />

        <FrequencyDomainView />
      </Stack>
    </Paper>
  );
}
