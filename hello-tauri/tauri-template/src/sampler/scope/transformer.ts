import { Accumulator } from "./accumulator.ts";
import { WaveletTransform, type CQTConfig } from "./wavelet-transform.ts";
import { Spectrogram, type SpectrogramConfig } from "./spectrogram.ts";

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
  //const C3 = 48; // MIDI note number for C3
  //const C8 = 96; // MIDI note number for C8
  const A1 = 33; // MIDI note number for C3
  return {
    fMin: midiToFrequency(A1),
    fMax: 20000,
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
  private spectrogram: Spectrogram;

  // CQT parameters
  private minWindowSize: number; // Minimum samples needed for CQT
  private batchFactor: number; // Frames per block (blockSize / hopLength)

  // Tracking for spectrogram updates
  private lastSpectrogramFrame: number = 0; // Last frame written to spectrogram
  private blocksProcessed: number = 0; // Track how many blocks have been processed
  private unprocessedBlocks: number = 0; // Track how many blocks have been processed

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
    };

    // Default batch factor (hardcoded, not user-configurable)
    this.batchFactor = 8;
    const hopLength = this.config.blockSize / this.batchFactor;

    // Calculate minimum window size for CQT
    //this.minWindowSize = this.calculateMinWindowSize() + hopLength;
    this.minWindowSize = 512 + hopLength;

    // Create accumulator with minWindowSize for proper buffer management
    // Pass processTransform as callback to be invoked when blocks are ready

    this.accumulator = new Accumulator(
      this.device,
      this.config.blockSize,
      this.config.maxBlocks,
      this.config.binsPerOctave,
      this.config.sampleRate,
      this.config.fMin,
      this.config.fMax,
      this.batchFactor,
      (inputOffset: number) => this.processTransform(inputOffset)
    );

    // Create wavelet transform (CQT)
    // WaveletTransform now creates and owns its output buffer
    const cqtConfig: CQTConfig = {
      sampleRate: this.config.sampleRate,
      fMin: this.config.fMin,
      fMax: this.config.fMax,
      binsPerOctave: this.config.binsPerOctave,
      blockSize: this.config.blockSize,
      batchFactor: this.batchFactor,
      maxBlocks: this.config.maxBlocks,
    };
    this.waveletTransform = new WaveletTransform(this.device, cqtConfig);



    // Configure the wavelet transform with the input buffer
    this.waveletTransform.configure(
      this.accumulator.getOutputBuffer(),
      this.accumulator.getOutputBufferSize()
    );

    //console.log(`Wavelet min window size: ${this.minWindowSize}`)
    //this.accumulator.setMinSamples(this.waveletTransform.getMinWindowSize());

    // Create spectrogram
    const spectrogramConfig: Partial<SpectrogramConfig> = {
      numBins: this.waveletTransform.getNumBins(),
    };
    this.spectrogram = new Spectrogram(this.device, spectrogramConfig);

    // Configure the spectrogram with the CQT output buffer
    // Texture width is 2048 frames to accumulate a longer timespan
    this.spectrogram.configure(
      this.waveletTransform.getOutputBuffer(),
      this.waveletTransform.getNumBins(),
      this.waveletTransform.getMaxTimeFrames(),
      2048 // Spectrogram texture width
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
    this.accumulator.addSamples(samples);
  }

  /**
   * Process a transform for a newly completed block
   * This method is called once for each block that has been added to the accumulator
   * and is ready for processing
   */
  processTransform(inputOffset: number): void {
    const outputBufferWriteOffset = this.accumulator.getOutputBufferWriteOffset();

    // Only process if we have enough samples
    if (outputBufferWriteOffset >= this.minWindowSize) {
      // Perform CQT transform (buffers already configured in constructor)
      // WaveletTransform now manages its own write position and always generates blockSize/batchFactor frames
      //console.log(inputOffset);
      this.waveletTransform.transform(inputOffset);

      // Update spectrogram textures with the newly generated CQT data
      // Calculate how many frames were just generated
      const framesGenerated = this.waveletTransform.getBatchFactor();
      const currentFrame = this.lastSpectrogramFrame + framesGenerated;

      // Update textures with the new frame range
      this.spectrogram.updateTextures(this.lastSpectrogramFrame, currentFrame);

      // Update tracking (wrap around at max)
      this.lastSpectrogramFrame = currentFrame % this.waveletTransform.getMaxTimeFrames();

      // Increment blocks processed counter
      this.blocksProcessed++;
    }
  }

  /**
   * Reset the transformer to initial state
   */
  reset(): void {
    this.accumulator.reset();
    this.waveletTransform.reset();
    this.spectrogram.reset();
    this.lastSpectrogramFrame = 0;
    this.blocksProcessed = 0;
  }

  /**
   * Cleanup and destroy WebGPU resources
   */
  destroy(): void {
    this.accumulator.destroy();
    this.waveletTransform.destroy();
    this.spectrogram.destroy();
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
   * Get the spectrogram instance
   */
  getSpectrogram(): Spectrogram {
    return this.spectrogram;
  }

  /**
   * Get the CQT output buffer (2D array: [time][frequency])
   * Delegates to WaveletTransform
   */
  getCQTOutputBuffer(): GPUBuffer {
    return this.waveletTransform.getOutputBuffer();
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

  /**
   * Get the hop length (samples per frame)
   */
  getHopLength(): number {
    return this.waveletTransform.getHopLength();
  }

  /**
   * Get the batch factor (frames per block)
   */
  getBatchFactor(): number {
    return this.batchFactor;
  }
}
