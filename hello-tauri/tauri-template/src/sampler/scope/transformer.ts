import { Accumulator } from "./accumulator.ts";
import { WaveletTransform, type CQTConfig } from "./wavelet-transform.ts";

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
  private waveletTransform: WaveletTransform;

  // CQT parameters
  private minWindowSize: number; // Minimum samples needed for CQT
  private cqtOutputOffset: number = 0; // Current write position in time frames

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

    // Create wavelet transform (CQT)
    // WaveletTransform now creates and owns its output buffer
    const cqtConfig: CQTConfig = {
      sampleRate: this.config.sampleRate,
      fMin: this.config.fMin,
      fMax: this.config.fMax,
      binsPerOctave: this.config.binsPerOctave,
      blockSize: this.config.blockSize,
      batchFactor: this.config.blockSize / this.config.hopLength, // Calculate batchFactor from hopLength
      maxBlocks: this.config.maxBlocks,
    };
    this.waveletTransform = new WaveletTransform(this.device, cqtConfig);

    // Configure the wavelet transform with the input buffer
    this.waveletTransform.configure(
      this.accumulator.getOutputBuffer(),
      this.accumulator.getOutputBufferSize()
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
      const blocksCompleted = this.accumulator.addSamples(chunk);

      // Process transform for each newly completed block
      for (let i = 0; i < blocksCompleted; i++) {
        this.processTransform();
      }

      offset += chunkSize;
    }
  }

  /**
   * Process a transform for a newly completed block
   * This method is called once for each block that has been added to the accumulator
   * and is ready for processing
   */
  processTransform(): void {
    // Calculate the input offset (use the most recent data)
    const inputOffset = Math.max(0, this.accumulator.getOutputBufferWriteOffset() - this.minWindowSize);

    // Calculate how many time frames we can compute from one block
    // This equals batchFactor (blockSize / hopLength)
    const numFrames = this.waveletTransform.getBatchFactor();

    // Check if we need to wrap the output buffer
    const maxTimeFrames = this.waveletTransform.getMaxTimeFrames();
    if (this.cqtOutputOffset + numFrames > maxTimeFrames) {
      this.cqtOutputOffset = 0; // Wrap around (ring buffer behavior)
    }

    // Only process if we have enough samples
    if (this.accumulator.getOutputBufferWriteOffset() >= this.minWindowSize) {
      // Perform CQT transform (buffers already configured in constructor)
      this.waveletTransform.transform(
        inputOffset,
        this.cqtOutputOffset,
        numFrames
      );

      // Advance output offset
      this.cqtOutputOffset += numFrames;
    }
  }

  /**
   * Reset the transformer to initial state
   */
  reset(): void {
    this.accumulator.reset();
    this.waveletTransform.reset();
    this.cqtOutputOffset = 0;
  }

  /**
   * Cleanup and destroy WebGPU resources
   */
  destroy(): void {
    this.accumulator.destroy();
    this.waveletTransform.destroy();
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

  /**
   * Get the wavelet transform instance
   */
  getWaveletTransform(): WaveletTransform {
    return this.waveletTransform;
  }

  /**
   * Get the CQT output buffer (2D array: [time][frequency])
   * Delegates to WaveletTransform
   */
  getCQTOutputBuffer(): GPUBuffer {
    return this.waveletTransform.getOutputBuffer();
  }

  /**
   * Get the current write offset in the CQT output buffer (in time frames)
   */
  getCQTOutputOffset(): number {
    return this.cqtOutputOffset;
  }

  /**
   * Get the maximum number of time frames that can be stored
   * Delegates to WaveletTransform
   */
  getMaxTimeFrames(): number {
    return this.waveletTransform.getMaxTimeFrames();
  }

  /**
   * Get the transformer configuration
   */
  getConfig(): TransformerConfig {
    return this.config;
  }
}
