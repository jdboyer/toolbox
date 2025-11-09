import { useState, useEffect } from "react";
import { Stack, Text, Table, Divider, ScrollArea, Group } from "@mantine/core";
import { IconLink, IconLinkOff } from "@tabler/icons-react";
import AnalyzerService from "../sampler/scope/analyzer-service.ts";
import type { TransformerConfig } from "../sampler/scope/transformer.ts";
import type { AnalyzerConfig } from "../sampler/scope/analyzer.ts";

interface AllSettings {
  analyzer: AnalyzerConfig;
  transformer: TransformerConfig;
  accumulator: {
    blockSize: number;
    maxBlocks: number;
    outputBufferSize: number;
    outputBufferWriteOffset: number;
    overlapRegionBlocks: number;
  };
  waveletTransform: {
    numBins: number;
    hopLength: number;
    batchFactor: number;
    blockSize: number;
    maxTimeFrames: number;
    writePosition: number;
    minWindowSize: number;
  };
  spectrogram: {
    textureWidth: number;
    textureHeight: number;
    writePosition: number;
    framesWritten: number;
    totalCapacity: number;
  };
}

// Helper component to render a setting row with link status indicator
interface SettingRowProps {
  label: string;
  value: string | number;
  isLinked?: boolean; // true = linked (blue), false = not linked (red), undefined = no icon
}

function SettingRow({ label, value, isLinked }: SettingRowProps) {
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap={4} wrap="nowrap">
          <Text size="xs">{label}</Text>
          {isLinked !== undefined && (
            isLinked ? (
              <IconLink size={12} color="var(--mantine-color-blue-6)" />
            ) : (
              <IconLinkOff size={12} color="var(--mantine-color-red-6)" />
            )
          )}
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{value}</Text>
      </Table.Td>
    </Table.Tr>
  );
}

export function AirwaveSettings() {
  const [settings, setSettings] = useState<AllSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const analyzer = await AnalyzerService.getAnalyzer();
        if (analyzer) {
          const transformer = analyzer.getTransformer();
          const accumulator = transformer.getAccumulator();
          const waveletTransform = transformer.getWaveletTransform();
          const spectrogram = transformer.getSpectrogram();

          const allSettings: AllSettings = {
            analyzer: analyzer.getConfig(),
            transformer: transformer.getConfig(),
            accumulator: {
              blockSize: accumulator.getBlockSize(),
              maxBlocks: accumulator.getMaxBlocks(),
              outputBufferSize: accumulator.getOutputBufferSize(),
              outputBufferWriteOffset: accumulator.getOutputBufferWriteOffset(),
              overlapRegionBlocks: accumulator.getOverlapRegionBlocks(),
            },
            waveletTransform: {
              numBins: waveletTransform.getNumBins(),
              hopLength: waveletTransform.getHopLength(),
              batchFactor: waveletTransform.getBatchFactor(),
              blockSize: waveletTransform.getBlockSize(),
              maxTimeFrames: waveletTransform.getMaxTimeFrames(),
              writePosition: waveletTransform.getWritePosition(),
              minWindowSize: waveletTransform.getMinWindowSize(),
            },
            spectrogram: {
              textureWidth: spectrogram.getTextureWidth(),
              textureHeight: spectrogram.getTextureHeight(),
              writePosition: spectrogram.getWritePosition(),
              framesWritten: spectrogram.getFramesWritten(),
              totalCapacity: spectrogram.getTotalCapacity(),
            },
          };

          setSettings(allSettings);
        }
      } catch (error) {
        console.error("Failed to load settings:", error);
      } finally {
        setIsLoading(false);
      }
    };

    loadSettings();
  }, []);

  // Helper function to check if a setting value is consistent across components
  const checkLinked = (getValue: (s: AllSettings) => number | undefined): boolean | undefined => {
    if (!settings) return undefined;

    const values = getValue(settings);
    if (values === undefined) return undefined;

    // For settings that appear in multiple places, we return true/false
    // For now, return undefined (will implement per-setting)
    return undefined;
  };

  // Check specific common settings
  const isSampleRateLinked = (): boolean | undefined => {
    if (!settings) return undefined;
    const rates = [settings.analyzer.sampleRate, settings.transformer.sampleRate];
    return rates.every(r => r === rates[0]) ? true : false;
  };

  const isMaxBlocksLinked = (): boolean | undefined => {
    if (!settings) return undefined;
    const blocks = [
      settings.transformer.maxBlocks,
      settings.accumulator.maxBlocks,
    ];
    return blocks.every(b => b === blocks[0]) ? true : false;
  };

  const isBlockSizeLinked = (): boolean | undefined => {
    if (!settings) return undefined;
    const sizes = [
      settings.transformer.blockSize,
      settings.accumulator.blockSize,
      settings.waveletTransform.blockSize,
    ];
    return sizes.every(s => s === sizes[0]) ? true : false;
  };

  if (isLoading) {
    return (
      <Stack gap="md" p="md">
        <Text size="sm" fw={500}>Airwave Settings</Text>
        <Text size="xs" c="dimmed">Loading...</Text>
      </Stack>
    );
  }

  if (!settings) {
    return (
      <Stack gap="md" p="md">
        <Text size="sm" fw={500}>Airwave Settings</Text>
        <Text size="xs" c="dimmed">Failed to load configuration</Text>
      </Stack>
    );
  }

  return (
    <ScrollArea style={{ height: '100%' }}>
      <Stack gap="md" p="md">
        <Text size="sm" fw={500}>System Settings</Text>

        {/* Analyzer Settings */}
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>ANALYZER</Text>
          <Table>
            <Table.Tbody>
              <SettingRow
                label="Sample Rate"
                value={`${settings.analyzer.sampleRate} Hz`}
                isLinked={isSampleRateLinked()}
              />
            </Table.Tbody>
          </Table>
        </div>

        <Divider />

        {/* Transformer Settings */}
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>TRANSFORMER</Text>
          <Table>
            <Table.Tbody>
              <SettingRow
                label="Sample Rate"
                value={`${settings.transformer.sampleRate} Hz`}
                isLinked={isSampleRateLinked()}
              />
              <SettingRow
                label="Block Size"
                value={settings.transformer.blockSize}
                isLinked={isBlockSizeLinked()}
              />
              <SettingRow
                label="Max Blocks"
                value={settings.transformer.maxBlocks}
                isLinked={isMaxBlocksLinked()}
              />
              <SettingRow
                label="Min Frequency"
                value={`${settings.transformer.fMin.toFixed(2)} Hz`}
              />
              <SettingRow
                label="Max Frequency"
                value={`${settings.transformer.fMax.toFixed(2)} Hz`}
              />
              <SettingRow
                label="Bins Per Octave"
                value={settings.transformer.binsPerOctave}
              />
            </Table.Tbody>
          </Table>
        </div>

        <Divider />

        {/* Accumulator Settings */}
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>ACCUMULATOR</Text>
          <Table>
            <Table.Tbody>
              <SettingRow
                label="Block Size"
                value={settings.accumulator.blockSize}
                isLinked={isBlockSizeLinked()}
              />
              <SettingRow
                label="Max Blocks"
                value={settings.accumulator.maxBlocks}
                isLinked={isMaxBlocksLinked()}
              />
              <SettingRow
                label="Output Buffer Size"
                value={settings.accumulator.outputBufferSize}
              />
              <SettingRow
                label="Write Offset"
                value={settings.accumulator.outputBufferWriteOffset}
              />
              <SettingRow
                label="Overlap Blocks"
                value={settings.accumulator.overlapRegionBlocks}
              />
            </Table.Tbody>
          </Table>
        </div>

        <Divider />

        {/* Wavelet Transform Settings */}
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>WAVELET TRANSFORM (CQT)</Text>
          <Table>
            <Table.Tbody>
              <SettingRow
                label="Num Bins"
                value={settings.waveletTransform.numBins}
              />
              <SettingRow
                label="Hop Length"
                value={settings.waveletTransform.hopLength}
              />
              <SettingRow
                label="Batch Factor"
                value={settings.waveletTransform.batchFactor}
              />
              <SettingRow
                label="Block Size"
                value={settings.waveletTransform.blockSize}
                isLinked={isBlockSizeLinked()}
              />
              <SettingRow
                label="Max Time Frames"
                value={settings.waveletTransform.maxTimeFrames}
              />
              <SettingRow
                label="Write Position"
                value={settings.waveletTransform.writePosition}
              />
              <SettingRow
                label="Min Window Size"
                value={settings.waveletTransform.minWindowSize}
              />
            </Table.Tbody>
          </Table>
        </div>

        <Divider />

        {/* Spectrogram Settings */}
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>SPECTROGRAM</Text>
          <Table>
            <Table.Tbody>
              <SettingRow
                label="Texture Width"
                value={settings.spectrogram.textureWidth}
              />
              <SettingRow
                label="Texture Height"
                value={settings.spectrogram.textureHeight}
              />
              <SettingRow
                label="Write Position"
                value={settings.spectrogram.writePosition}
              />
              <SettingRow
                label="Frames Written"
                value={settings.spectrogram.framesWritten}
              />
              <SettingRow
                label="Total Capacity"
                value={settings.spectrogram.totalCapacity}
              />
            </Table.Tbody>
          </Table>
        </div>
      </Stack>
    </ScrollArea>
  );
}
