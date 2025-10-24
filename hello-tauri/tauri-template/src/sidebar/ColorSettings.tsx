import { Stack, ColorInput, Text } from "@mantine/core";

interface ColorSettingsProps {
  color0: string;
  color1: string;
  color2: string;
  color3: string;
  color4: string;
  onColor0Change: (value: string) => void;
  onColor1Change: (value: string) => void;
  onColor2Change: (value: string) => void;
  onColor3Change: (value: string) => void;
  onColor4Change: (value: string) => void;
}

export function ColorSettings({
  color0,
  color1,
  color2,
  color3,
  color4,
  onColor0Change,
  onColor1Change,
  onColor2Change,
  onColor3Change,
  onColor4Change,
}: ColorSettingsProps) {
  return (
    <Stack gap="md" p="md">
      <Text size="sm" fw={500}>Spectrogram Colors</Text>
      <Stack gap="sm">
        <ColorInput
          label="Color 0 (Low)"
          description="Lowest magnitude values"
          value={color0}
          onChange={onColor0Change}
          format="hex"
          size="xs"
        />
        <ColorInput
          label="Color 1"
          description="Low-mid magnitude values"
          value={color1}
          onChange={onColor1Change}
          format="hex"
          size="xs"
        />
        <ColorInput
          label="Color 2 (Mid)"
          description="Middle magnitude values"
          value={color2}
          onChange={onColor2Change}
          format="hex"
          size="xs"
        />
        <ColorInput
          label="Color 3"
          description="Mid-high magnitude values"
          value={color3}
          onChange={onColor3Change}
          format="hex"
          size="xs"
        />
        <ColorInput
          label="Color 4 (High)"
          description="Highest magnitude values"
          value={color4}
          onChange={onColor4Change}
          format="hex"
          size="xs"
        />
      </Stack>
    </Stack>
  );
}
