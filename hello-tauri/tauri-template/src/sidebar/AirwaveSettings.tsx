import { useState, useEffect } from "react";
import { Stack, Text, Table } from "@mantine/core";
import AnalyzerService from "../sampler/scope/analyzer-service.ts";
import type { TransformerConfig } from "../sampler/scope/transformer.ts";

export function AirwaveSettings() {
  const [config, setConfig] = useState<TransformerConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const analyzer = await AnalyzerService.getAnalyzer();
        if (analyzer) {
          const transformer = analyzer.getTransformer();
          const transformerConfig = transformer.getConfig();
          setConfig(transformerConfig);
        }
      } catch (error) {
        console.error("Failed to load transformer config:", error);
      } finally {
        setIsLoading(false);
      }
    };

    loadConfig();
  }, []);

  if (isLoading) {
    return (
      <Stack gap="md" p="md">
        <Text size="sm" fw={500}>Airwave Settings</Text>
        <Text size="xs" c="dimmed">Loading...</Text>
      </Stack>
    );
  }

  if (!config) {
    return (
      <Stack gap="md" p="md">
        <Text size="sm" fw={500}>Airwave Settings</Text>
        <Text size="xs" c="dimmed">Failed to load configuration</Text>
      </Stack>
    );
  }

  return (
    <Stack gap="md" p="md">
      <Text size="sm" fw={500}>Transformer Settings</Text>
      <Table>
        <Table.Tbody>
          <Table.Tr>
            <Table.Td>
              <Text size="xs" fw={500}>Sample Rate</Text>
            </Table.Td>
            <Table.Td>
              <Text size="xs">{config.sampleRate} Hz</Text>
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>
              <Text size="xs" fw={500}>Block Size</Text>
            </Table.Td>
            <Table.Td>
              <Text size="xs">{config.blockSize}</Text>
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>
              <Text size="xs" fw={500}>Max Blocks</Text>
            </Table.Td>
            <Table.Td>
              <Text size="xs">{config.maxBlocks}</Text>
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>
              <Text size="xs" fw={500}>Min Frequency</Text>
            </Table.Td>
            <Table.Td>
              <Text size="xs">{config.fMin.toFixed(2)} Hz</Text>
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>
              <Text size="xs" fw={500}>Max Frequency</Text>
            </Table.Td>
            <Table.Td>
              <Text size="xs">{config.fMax.toFixed(2)} Hz</Text>
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>
              <Text size="xs" fw={500}>Bins Per Octave</Text>
            </Table.Td>
            <Table.Td>
              <Text size="xs">{config.binsPerOctave}</Text>
            </Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
