import { useState, useEffect } from "react";
import { Stack, Text, Table, Divider, ScrollArea } from "@mantine/core";
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
              <Table.Tr>
                <Table.Td><Text size="xs">Sample Rate</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.analyzer.sampleRate} Hz</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Block Size</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.analyzer.blockSize}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Max Blocks</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.analyzer.maxBlocks}</Text></Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </div>

        <Divider />

        {/* Transformer Settings */}
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>TRANSFORMER</Text>
          <Table>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td><Text size="xs">Sample Rate</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.transformer.sampleRate} Hz</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Block Size</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.transformer.blockSize}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Max Blocks</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.transformer.maxBlocks}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Min Frequency</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.transformer.fMin.toFixed(2)} Hz</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Max Frequency</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.transformer.fMax.toFixed(2)} Hz</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Bins Per Octave</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.transformer.binsPerOctave}</Text></Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </div>

        <Divider />

        {/* Accumulator Settings */}
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>ACCUMULATOR</Text>
          <Table>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td><Text size="xs">Block Size</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.accumulator.blockSize}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Max Blocks</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.accumulator.maxBlocks}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Output Buffer Size</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.accumulator.outputBufferSize}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Write Offset</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.accumulator.outputBufferWriteOffset}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Overlap Blocks</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.accumulator.overlapRegionBlocks}</Text></Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </div>

        <Divider />

        {/* Wavelet Transform Settings */}
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>WAVELET TRANSFORM (CQT)</Text>
          <Table>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td><Text size="xs">Num Bins</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.waveletTransform.numBins}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Hop Length</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.waveletTransform.hopLength}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Batch Factor</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.waveletTransform.batchFactor}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Block Size</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.waveletTransform.blockSize}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Max Time Frames</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.waveletTransform.maxTimeFrames}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Write Position</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.waveletTransform.writePosition}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Min Window Size</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.waveletTransform.minWindowSize}</Text></Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </div>

        <Divider />

        {/* Spectrogram Settings */}
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>SPECTROGRAM</Text>
          <Table>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td><Text size="xs">Texture Width</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.spectrogram.textureWidth}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Texture Height</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.spectrogram.textureHeight}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Write Position</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.spectrogram.writePosition}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Frames Written</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.spectrogram.framesWritten}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs">Total Capacity</Text></Table.Td>
                <Table.Td><Text size="xs">{settings.spectrogram.totalCapacity}</Text></Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </div>
      </Stack>
    </ScrollArea>
  );
}
