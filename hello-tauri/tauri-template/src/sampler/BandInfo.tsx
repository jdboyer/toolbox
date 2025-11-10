import { Text, Stack, Table } from "@mantine/core";
import { useEffect, useState } from "react";
import AnalyzerService from "./scope/analyzer-service.ts";
import type { BandSettings } from "./scope/accumulator.ts";
import type { FilterResponse } from "./scope/decimator.ts";
import { CanvasChart } from "./CanvasChart.tsx";

/**
 * BandInfo - Displays information about decimator bands
 */
export function BandInfo() {
  const [bandSettings, setBandSettings] = useState<BandSettings[]>([]);
  const [filterResponses, setFilterResponses] = useState<FilterResponse[]>([]);

  useEffect(() => {
    const loadBandSettings = async () => {
      const analyzer = await AnalyzerService.getAnalyzer();
      if (analyzer) {
        const accumulator = analyzer.getTransformer().getAccumulator();
        const settings = accumulator.getBandSettings();
        setBandSettings(settings);

        // Calculate filter responses for all bands
        const responses = settings.map((band) => band.getFilterResponse(512, 20, 24000));
        setFilterResponses(responses);
      }
    };

    loadBandSettings();
  }, []);

  if (bandSettings.length === 0) {
    return <Text>Loading band settings...</Text>;
  }

  // Chart configuration
  const chartWidth = 800;
  const chartHeight = 200;
  const fMin = 55;
  const fMax = 20000;
  const magnitudeMin = -10; // dB
  const magnitudeMax = 5; // dB

  // Logarithmic transform for frequency (X-axis)
  // log10(f) maps to canvas px
  const logFMin = Math.log10(fMin);
  const logFMax = Math.log10(fMax);
  const xTransform = {
    slope: (logFMax - logFMin) / chartWidth,
    offset: logFMin,
  };

  // Linear transform for magnitude in dB (Y-axis)
  // Higher magnitude at top (lower y px), lower magnitude at bottom (higher y px)
  const yTransform = {
    slope: (magnitudeMin - magnitudeMax) / chartHeight,
    offset: magnitudeMax,
  };

  // Color palette for bands
  const colors = [
    "#e74c3c", // Red
    "#3498db", // Blue
    "#2ecc71", // Green
    "#f39c12", // Orange
    "#9b59b6", // Purple
    "#1abc9c", // Turquoise
    "#e67e22", // Carrot
    "#95a5a6", // Gray
  ];

  // Render function for the chart
  const renderChart = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    // Helper to convert chart coordinates to canvas pixels
    const freqToX = (freq: number) => {
      const logFreq = Math.log10(freq);
      return (logFreq - xTransform.offset) / xTransform.slope;
    };

    const magToY = (mag: number) => {
      return (mag - yTransform.offset) / yTransform.slope;
    };

    // Draw background
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, width, height);

    // Draw grid lines
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1;

    // Vertical grid lines at octaves (10, 100, 1000, 10000 Hz)
    const octaveFreqs = [10, 100, 1000, 10000];
    octaveFreqs.forEach(freq => {
      const x = freqToX(freq);
      if (x >= 0 && x <= width) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();

        // Label
        ctx.fillStyle = "#888";
        ctx.font = "10px monospace";
        ctx.fillText(`${freq}Hz`, x + 2, height - 5);
      }
    });

    // Horizontal grid lines every 20 dB
    for (let db = magnitudeMin; db <= magnitudeMax; db += 10) {
      const y = magToY(db);
      if (y >= 0 && y <= height) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();

        // Label
        ctx.fillStyle = "#888";
        ctx.font = "10px monospace";
        ctx.fillText(`${db}dB`, 5, y - 2);
      }
    }

    // Draw 0 dB reference line more prominently
    const y0dB = magToY(0);
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y0dB);
    ctx.lineTo(width, y0dB);
    ctx.stroke();

    // Draw filter responses for each band
    filterResponses.forEach((response, bandIndex) => {
      const color = colors[bandIndex % colors.length];

      // Create filled area
      ctx.fillStyle = color + "40"; // Add alpha for transparency
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;

      ctx.beginPath();

      // Start from bottom left
      const startX = freqToX(response.frequencies[0]);
      const startY = magToY(magnitudeMin);
      ctx.moveTo(startX, startY);

      // Draw path along the magnitude response
      response.frequencies.forEach((freq, i) => {
        const x = freqToX(freq);
        const y = magToY(response.magnitudeDB[i]);
        if (i === 0) {
          ctx.lineTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      // Close path to bottom right
      const endX = freqToX(response.frequencies[response.frequencies.length - 1]);
      ctx.lineTo(endX, magToY(magnitudeMin));
      ctx.closePath();

      // Fill the area
      ctx.fill();

      // Draw the line on top
      ctx.beginPath();
      //clamp = false;
      response.frequencies.forEach((freq, i) => {
        const x = freqToX(freq);
        const y = magToY(response.magnitudeDB[i]);
        //if (!clamp) {
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        //}
        //if (y <= magToY(-40)) {
          ////clamp = true;
        //}
      });
      ctx.stroke();
    });

    // Draw band cutoff frequency markers
    bandSettings.forEach((band, index) => {
      const x = freqToX(band.cutoffFrequency);
      const color = colors[index % colors.length];

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label with band number
      ctx.fillStyle = color;
      ctx.font = "bold 11px monospace";
      ctx.fillText(`Band ${index}`, x + 3, 15);
    });

    // Draw kernel frequency range indicators at -6 dB
    const kernelIndicatorY = magToY(-6);
    bandSettings.forEach((band, index) => {
      if (band.kernelFrequencies.length === 0) return;

      const color = colors[index % colors.length];
      const firstKernelFreq = band.kernelFrequencies[0];
      const lastKernelFreq = band.kernelFrequencies[band.kernelFrequencies.length - 1];

      const x1 = freqToX(firstKernelFreq);
      const x2 = freqToX(lastKernelFreq);

      // Draw thick line segment
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1, kernelIndicatorY);
      ctx.lineTo(x2, kernelIndicatorY);
      ctx.stroke();

      // Draw end caps
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, kernelIndicatorY - 4);
      ctx.lineTo(x1, kernelIndicatorY + 4);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x2, kernelIndicatorY - 4);
      ctx.lineTo(x2, kernelIndicatorY + 4);
      ctx.stroke();
    });
  };

  const renderTooltip = (chartX: number, chartY: number) => {
    // chartX is log10(freq), chartY is magnitude in dB
    const freq = Math.pow(10, chartX);
    return (
      <>
        <div>Freq: {freq.toFixed(2)} Hz</div>
        <div>Mag: {chartY.toFixed(2)} dB</div>
      </>
    );
  };

  return (
    <Stack gap="md">
      <Text size="lg" fw={700}>Band Settings</Text>

      {/* Frequency Response Chart */}
      <Stack gap="xs">
        <Text size="md" fw={600}>Filter Frequency Response</Text>
        <CanvasChart
          width={chartWidth}
          height={chartHeight}
          xTransform={xTransform}
          yTransform={yTransform}
          onRender={renderChart}
          renderTooltip={renderTooltip}
        />
      </Stack>

      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Band</Table.Th>
            <Table.Th>Cutoff Freq (Hz)</Table.Th>
            <Table.Th>Decimation Factor</Table.Th>
            <Table.Th>Cumulative Factor</Table.Th>
            <Table.Th>Effective Sample Rate (Hz)</Table.Th>
            <Table.Th>Max Kernel Size</Table.Th>
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

            const color = colors[index % colors.length];

            return (
              <Table.Tr key={index}>
                <Table.Td>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <div style={{ width: "12px", height: "12px", backgroundColor: color, borderRadius: "2px" }} />
                    {index}
                  </div>
                </Table.Td>
                <Table.Td>{band.cutoffFrequency.toFixed(2)}</Table.Td>
                <Table.Td>{band.decimationFactor}</Table.Td>
                <Table.Td>{band.cumulativeDecimationFactor}</Table.Td>
                <Table.Td>{band.effectiveSampleRate.toFixed(2)}</Table.Td>
                <Table.Td>{band.maxKernelSize}</Table.Td>
                <Table.Td>{kernelInfo}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
