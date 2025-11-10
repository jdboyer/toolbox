import { Stack, Group, ActionIcon, Text } from "@mantine/core";
import { IconFolder, IconEyeDiscount } from "@tabler/icons-react";
import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { TimeDomainView } from "./TimeDomainView.tsx";
// import { FrequencyDomainView } from "./FrequencyDomainView";
import { ScopeView } from "./scope/ScopeView.tsx";
import { BandInfo } from "./BandInfo.tsx";
import AnalyzerService from "./scope/analyzer-service.ts";

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
  const [showBandInfo, setShowBandInfo] = useState(false);

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
        const data = await invoke<WavData>("read_wav_file", { filePath: selectedFile });
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
        analyzer.reset();

        // Convert to Float32Array and send to analyzer
        // Add zero padding at the end so we can process the entire sample
        // (CQT needs maxKernelLength samples in buffer to compute a frame)
        const paddingLength = 50000; // Enough for 50Hz at 48kHz
        const paddedSamples = new Float32Array(wavData.samples.length + paddingLength);
        paddedSamples.set(wavData.samples);
        // Rest is already zeros

        analyzer.processSamples(paddedSamples);
      } catch (error) {
        console.error("Failed to process WAV data:", error);
      }
    };

    processWavData();
  }, [wavData]);

  const handleSelectFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'Audio',
          extensions: ['wav', 'mp3', 'flac', 'ogg', 'aiff', 'aac']
        }]
      });

      if (selected && typeof selected === 'string') {
        setSelectedFile(selected);
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
      <Group justify="space-between">
        <Group>
          <ActionIcon onClick={handleSelectFile} variant="default" size="lg">
            <IconFolder size={18} />
          </ActionIcon>
          <Text>{getFileName()}</Text>
        </Group>
        <ActionIcon
          onClick={() => setShowBandInfo(!showBandInfo)}
          variant={showBandInfo ? "filled" : "default"}
          size="lg"
        >
          <IconEyeDiscount size={18} />
        </ActionIcon>
      </Group>

      {showBandInfo ? (
        <div style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <BandInfo />
        </div>
      ) : (
        <>
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
              timeRange={timeRange}
              timeOffset={timeOffset}
              sampleRate={wavData?.sample_rate || 48000}
            />
          </div>
        </>
      )}
    </Stack>
  );
}
