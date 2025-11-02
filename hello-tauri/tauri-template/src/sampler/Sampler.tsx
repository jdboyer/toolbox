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

        // Convert to Float32Array and send to analyzer
        const samplesFloat32 = new Float32Array(wavData.samples);

        console.log(`Processing ${samplesFloat32.length} samples at ${wavData.sample_rate} Hz`);
        analyzer.processSamples(samplesFloat32);
        console.log("Samples sent to analyzer - spectrogram should be rendering!");
        console.log("Current column after processing:", analyzer.getCurrentColumn());
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
