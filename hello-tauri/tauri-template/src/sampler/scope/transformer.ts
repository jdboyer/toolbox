import { Accumulator } from "./accumulator";

export interface TransformerConfig {
  /** Sample rate in Hz (e.g., 44100, 48000) */
  sampleRate: number;

  /** Number of samples per block */
  blockSize: number;
  /** Maximum number of blocks in the ring buffer */
  maxBlocks: number;

  /** Minimum frequency for CQT (Hz) */
  fMin: number;
  /** Maximum frequency for CQT (Hz) */
  fMax: number;
  /** Number of frequency bins per octave */
  binsPerOctave: number;
  /** Hop length in samples */
  hopLength: number;
}

/**
 * Convert MIDI note number to frequency in Hz
 * @param midiNote MIDI note number (0-127)
 * @returns Frequency in Hz
 */
function midiToFrequency(midiNote: number): number {
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

/**
 * Get default frequency range (C3 to C8)
 */
function getDefaultFrequencyRange(): { fMin: number; fMax: number } {
  const C3 = 48; // MIDI note number for C3
  const C8 = 96; // MIDI note number for C8
  return {
    fMin: midiToFrequency(C3),
    fMax: midiToFrequency(C8),
  };
}
/**
 * Transformer - Processes audio blocks using WebGPU
 *
 * This class is responsible for:
 * 1. Managing WebGPU compute pipelines for audio processing
 * 2. Processing blocks from the Accumulator
 * 3. Generating frequency-domain representations
 */
export class Transformer {
  private device: GPUDevice;
  private accumulator: Accumulator;
  private config: TransformerConfig;

  // CQT parameters
  private minWindowSize: number; // Minimum samples needed for CQT

  /**
   * Create a Transformer instance
   * @param device Pre-initialized WebGPU device
   * @param config Optional configuration (uses defaults if not provided)
   */
  constructor(device: GPUDevice, config?: Partial<TransformerConfig>) {
    this.device = device;

    // Set default configuration
    const defaultFreqRange = getDefaultFrequencyRange();
    this.config = {
      sampleRate: config?.sampleRate ?? 48000,
      blockSize: config?.blockSize ?? 4096,
      maxBlocks: config?.maxBlocks ?? 64,
      fMin: config?.fMin ?? defaultFreqRange.fMin,
      fMax: config?.fMax ?? defaultFreqRange.fMax,
      binsPerOctave: config?.binsPerOctave ?? 12,
      hopLength: config?.hopLength ?? 512,
    };

    // Calculate minimum window size for CQT
    this.minWindowSize = this.calculateMinWindowSize() + this.config.hopLength;

    // Create accumulator with minWindowSize for proper buffer management
    this.accumulator = new Accumulator(
      this.device,
      this.config.blockSize,
      this.config.maxBlocks,
      this.minWindowSize
    );
  }


  /**
   * Calculate the minimum window size needed for CQT
   * Based on the lowest frequency and sample rate
   * @returns Minimum number of samples needed
   */
  private calculateMinWindowSize(): number {
    // For CQT, the window size for the lowest frequency is:
    // windowSize = (sampleRate * Q) / fMin
    // where Q = 1 / (2^(1/binsPerOctave) - 1)
    const Q = 1 / (Math.pow(2, 1 / this.config.binsPerOctave) - 1);
    const windowSize = Math.ceil((this.config.sampleRate * Q) / this.config.fMin);
    return windowSize;
  }

  /**
   * Add samples to the transformer
   * Samples are added to the accumulator in chunks of at most 65536 samples
   * The accumulator automatically prepares the output buffer when blocks are completed
   * @param samples Float32Array containing audio samples
   */
  addSamples(samples: Float32Array): void {
    const MAX_CHUNK_SIZE = 65536;
    let offset = 0;

    while (offset < samples.length) {
      const remainingSamples = samples.length - offset;
      const chunkSize = Math.min(MAX_CHUNK_SIZE, remainingSamples);
      const chunk = samples.subarray(offset, offset + chunkSize);

      // Accumulator handles block completion and output buffer preparation
      this.accumulator.addSamples(chunk);

      offset += chunkSize;
    }
  }

  /**
   * Reset the transformer to initial state
   */
  reset(): void {
    this.accumulator.reset();
  }

  /**
   * Cleanup and destroy WebGPU resources
   */
  destroy(): void {
    this.accumulator.destroy();
  }

  /**
   * Get the WebGPU device
   */
  getDevice(): GPUDevice {
    return this.device;
  }

  /**
   * Get the accumulator instance
   */
  getAccumulator(): Accumulator {
    return this.accumulator;
  }
}
