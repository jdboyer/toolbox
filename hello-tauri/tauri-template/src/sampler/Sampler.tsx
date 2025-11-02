import { Stack, Group, ActionIcon, Text } from "@mantine/core";
import { IconFolder } from "@tabler/icons-react";
import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { TimeDomainView } from "./TimeDomainView";
// import { FrequencyDomainView } from "./FrequencyDomainView";
import { ScopeView } from "./scope/ScopeView";
import AnalyzerService from "./scope/analyzer-service";

interface WavData {
  samples: number[];
  sample_rate: number;
  duration_ms: number;
}

interface SamplerProps {
  color0: string;
  color1: string;
  color2: string;
  color3: string;
  color4: string;
}

export function Sampler({ }: SamplerProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [wavData, setWavData] = useState<WavData | null>(null);

  // Canvas dimensions
  const canvasWidth = 1400;
  const timeDomainHeight = 100;
  const frequencyDomainHeight = 400;

  // Time axis state (in milliseconds)
  const [timeRange, setTimeRange] = useState(4000); // Total time range visible (ms)
  const [timeOffset, setTimeOffset] = useState(0); // Time offset from 0 (ms)

  // Load WAV file when path changes
  useEffect(() => {
    if (!selectedFile) {
      setWavData(null);
      return;
    }

    const loadWavFile = async () => {
      try {
        console.log("Loading WAV file:", selectedFile);
        const data = await invoke<WavData>("read_wav_file", { filePath: selectedFile });
        console.log("WAV data loaded:", data);
        setWavData(data);
      } catch (error) {
        console.error("Failed to load WAV file:", error);
        setWavData(null);
      }
    };

    loadWavFile();
  }, [selectedFile]);

  // Process and send WAV data to analyzer when loaded
  useEffect(() => {
    if (!wavData) return;

    const processWavData = async () => {
      try {
        // Get the analyzer instance
        const analyzer = await AnalyzerService.getAnalyzer();
        if (!analyzer) {
          console.error("Failed to get Analyzer instance");
          return;
        }

        // Reset the analyzer to clear previous data
        console.log("Resetting analyzer for new WAV file");
        analyzer.reset();

        // Use the entire sample
        const sampleRate = wavData.sample_rate;

        // Get the actual block size from the analyzer
        const analyzerConfig = analyzer.getConfig();
        const blockSize = analyzerConfig.blockSize;

        // Calculate the number of samples, ensuring it's divisible by blockSize
        let numSamples = wavData.samples.length;
        numSamples = Math.floor(numSamples / blockSize) * blockSize;

        // Extract the samples (trim to block-aligned length)
        const extractedSamples = wavData.samples.slice(0, numSamples);

        // Find min/max without spreading (to avoid stack overflow on large arrays)
        let minVal = extractedSamples[0];
        let maxVal = extractedSamples[0];
        for (let i = 1; i < extractedSamples.length; i++) {
          if (extractedSamples[i] < minVal) minVal = extractedSamples[i];
          if (extractedSamples[i] > maxVal) maxVal = extractedSamples[i];
        }

        console.log(`Using entire sample: ${extractedSamples.length} samples (${numSamples / sampleRate}s)`);
        console.log(`Sample rate: ${sampleRate} Hz`);
        console.log(`Sample value range: ${minVal} to ${maxVal}`);

        // TEST: Use the known-good CQT to verify our visualization
        console.log("=== RUNNING CQT TEST ===");
        const { computeCQT } = await import("./cqt/cqt");
        const cqtResult = await computeCQT(new Float32Array(extractedSamples), {
          sampleRate: sampleRate,
          fmin: 32.7,
          fmax: 16000,
          binsPerOctave: 12,
          hopLength: 256,
        });
        console.log(`CQT Result: ${cqtResult.numBins} bins × ${cqtResult.numFrames} frames`);

        // Find min/max without spreading (to avoid stack overflow)
        let cqtMin = cqtResult.magnitudes[0];
        let cqtMax = cqtResult.magnitudes[0];
        let nonZeroCount = 0;
        for (let i = 0; i < cqtResult.magnitudes.length; i++) {
          const val = cqtResult.magnitudes[i];
          if (val < cqtMin) cqtMin = val;
          if (val > cqtMax) cqtMax = val;
          if (val > 0.001) nonZeroCount++;
        }

        console.log(`CQT data range: ${cqtMin} to ${cqtMax}`);
        console.log(`Non-zero values: ${nonZeroCount}`);

        // Convert to Float32Array and send to analyzer
        const samplesFloat32 = new Float32Array(extractedSamples);

        // Log accumulator state before processing
        const accumulator = analyzer.getAccumulator();
        console.log(`Accumulator config: blockSize=${accumulator.getBlockSize()}, maxBlocks=${accumulator.getMaxBlocks()}`);

        analyzer.processSamples(samplesFloat32);

        console.log("Samples sent to analyzer");

        // Log accumulator state after processing
        console.log(`Accumulator after processing: firstValid=${accumulator.getFirstValidBlockIndex()}, lastValid=${accumulator.getLastValidBlockIndex()}, processIndex=${accumulator.getProcessBlockIndex()}`);

        // Log transformer state
        const transformer = analyzer.getTransformer();
        const outputRing = transformer.getOutputBufferRing();
        const textureRing = transformer.getTextureBufferRing();
        const config = transformer.getConfig();
        console.log(`Transformer config: ${config.frequencyBinCount} bins × ${config.timeSliceCount} slices`);
        console.log(`Output ring count: ${outputRing.getCount()}, Texture ring count: ${textureRing.getCount()}`);
        console.log(`Texture ring write index: ${textureRing.getWriteIndex()}, read index: ${textureRing.getReadIndex()}`);

        // Read back one output buffer to check the data
        if (outputRing.getCount() > 0) {
          const device = analyzer.getDevice();
          const testOutputBuffer = outputRing.getBuffer(0);

          // Create staging buffer for readback
          const stagingBuffer = device.createBuffer({
            size: testOutputBuffer.size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });

          const commandEncoder = device.createCommandEncoder();
          commandEncoder.copyBufferToBuffer(testOutputBuffer, 0, stagingBuffer, 0, testOutputBuffer.size);
          device.queue.submit([commandEncoder.finish()]);

          await stagingBuffer.mapAsync(GPUMapMode.READ);
          const outputData = new Float32Array(stagingBuffer.getMappedRange());
          const outputCopy = new Float32Array(outputData); // Copy before unmapping
          stagingBuffer.unmap();
          stagingBuffer.destroy();

          console.log(`=== WAVELET TRANSFORM OUTPUT BUFFER 0 ===`);
          console.log(`Buffer size: ${outputCopy.length} floats`);

          // Find min/max and count non-zero values without spreading
          let outMin = outputCopy[0];
          let outMax = outputCopy[0];
          let outNonZero = 0;
          for (let i = 0; i < outputCopy.length; i++) {
            const val = outputCopy[i];
            if (val < outMin) outMin = val;
            if (val > outMax) outMax = val;
            if (Math.abs(val) > 0.001) outNonZero++;
          }

          console.log(`Data range: ${outMin} to ${outMax}`);
          console.log(`Non-zero values: ${outNonZero}`);
          console.log(`First 20 values:`, Array.from(outputCopy.slice(0, 20)));
        }

        // Trigger a manual render to update the view
        const renderer = analyzer.getScopeRenderer();
        if (renderer) {
          console.log("Triggering manual render");
          renderer.render();
        }
      } catch (error) {
        console.error("Failed to process WAV data:", error);
      }
    };

    processWavData();
  }, [wavData]);

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
        wavFilePath={selectedFile}
      />

      <div style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ScopeView
          canvasWidth={canvasWidth}
          canvasHeight={frequencyDomainHeight}
        />
      </div>
    </Stack>
  );
}
