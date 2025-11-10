import { Text, Stack, Table } from "@mantine/core";
import { useEffect, useState } from "react";
import AnalyzerService from "./scope/analyzer-service.ts";
import type { BandSettings } from "./scope/accumulator.ts";

/**
 * BandInfo - Displays information about decimator bands
 */
export function BandInfo() {
  const [bandSettings, setBandSettings] = useState<BandSettings[]>([]);

  useEffect(() => {
    const loadBandSettings = async () => {
      const analyzer = await AnalyzerService.getAnalyzer();
      if (analyzer) {
        const accumulator = analyzer.getTransformer().getAccumulator();
        const settings = accumulator.getBandSettings();
        setBandSettings(settings);
      }
    };

    loadBandSettings();
  }, []);

  if (bandSettings.length === 0) {
    return <Text>Loading band settings...</Text>;
  }

  return (
    <Stack gap="md">
      <Text size="lg" fw={700}>Band Settings</Text>
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Band</Table.Th>
            <Table.Th>Cutoff Freq (Hz)</Table.Th>
            <Table.Th>Decimation Factor</Table.Th>
            <Table.Th>Cumulative Factor</Table.Th>
            <Table.Th>Effective Sample Rate (Hz)</Table.Th>
            <Table.Th>Kernel Frequencies</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {bandSettings.map((band, index) => {
            const kernelCount = band.kernelFrequencies.length;
            const kernalRange = Math.log2(band.kernelFrequencies[kernelCount - 1] / band.kernelFrequencies[0]);
            const kernelInfo = kernelCount === 0
              ? "None"
              : kernelCount === 1
              ? `${band.kernelFrequencies[0].toFixed(2)} Hz (1 kernel)`
              : `${band.kernelFrequencies[0].toFixed(2)} - ${band.kernelFrequencies[kernelCount - 1].toFixed(2)} (${kernalRange.toFixed(2)}) Hz (${kernelCount} kernels)`;

            return (
              <Table.Tr key={index}>
                <Table.Td>{index}</Table.Td>
                <Table.Td>{band.cutoffFrequency.toFixed(2)}</Table.Td>
                <Table.Td>{band.decimationFactor}</Table.Td>
                <Table.Td>{band.cumulativeDecimationFactor}</Table.Td>
                <Table.Td>{band.effectiveSampleRate.toFixed(2)}</Table.Td>
                <Table.Td>{kernelInfo}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
