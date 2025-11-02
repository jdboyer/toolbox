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

  // WebGPU buffers
  private inputBuffer: GPUBuffer;
  private inputBufferWriteOffset: number = 0;
  private readonly INPUT_BUFFER_SIZE = 4096 * 16; // samples

  // CQT parameters
  private minWindowSize: number; // Minimum samples needed for CQT
  private lastProcessedBlockIndex: number = -1;

  /**
   * Create a Transformer instance
   * @param device Pre-initialized WebGPU device
   * @param config Optional configuration (uses defaults if not provided)
   */
  constructor(device: GPUDevice, config?: Partial<TransformerConfig>) {
    this.device = device;
    this.accumulator = new Accumulator(this.device);

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
    this.minWindowSize = this.calculateMinWindowSize();

    // Create input buffer (4096 * 16 samples = 65536 * 4 bytes)
    this.inputBuffer = this.device.createBuffer({
      size: this.INPUT_BUFFER_SIZE * 4, // Float32 = 4 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
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
   * If complete blocks are filled, processBlocks() is called automatically
   * @param samples Float32Array containing audio samples
   */
  addSamples(samples: Float32Array): void {
    const MAX_CHUNK_SIZE = 65536;
    let offset = 0;

    while (offset < samples.length) {
      const remainingSamples = samples.length - offset;
      const chunkSize = Math.min(MAX_CHUNK_SIZE, remainingSamples);
      const chunk = samples.subarray(offset, offset + chunkSize);

      const buffersCompleted = this.accumulator.addSamples(chunk);

      // Process any newly completed blocks
      if (buffersCompleted > 0) {
        this.processBlocks();
      }

      offset += chunkSize;
    }
  }
  /**
   * Process blocks from the accumulator
   * Iterates through newly completed blocks and prepares them for CQT
   */
  processBlocks(): void {
    const totalBuffersWritten = this.accumulator.getInputRingBuffer().getTotalBuffersWritten();
    const currentBlockIndex = totalBuffersWritten - 1;

    // Process all blocks since last processed
    for (let i = this.lastProcessedBlockIndex + 1; i <= currentBlockIndex; i++) {
      this.prepareBuffer(i);
    }

    this.lastProcessedBlockIndex = currentBlockIndex;
  }

  /**
   * Prepare the input buffer with samples from a completed block
   * Handles buffer overflow by resetting and backfilling with previous blocks
   * @param blockIndex Index of the block to prepare
   */
  private prepareBuffer(blockIndex: number): void {
    const blockSize = this.accumulator.getBlockSize();
    const samplesNeeded = blockSize;

    // Check if there's enough room in the input buffer
    if (this.inputBufferWriteOffset + samplesNeeded > this.INPUT_BUFFER_SIZE) {
      // Not enough room - reset buffer and backfill with previous blocks
      this.inputBufferWriteOffset = 0;

      // Calculate how many previous blocks we need to maintain at least minWindowSize
      const blocksNeeded = Math.ceil(this.minWindowSize / blockSize);
      const startBlockIndex = Math.max(0, blockIndex - blocksNeeded + 1);

      // Copy previous blocks to ensure we have enough context for CQT
      for (let i = startBlockIndex; i < blockIndex; i++) {
        const buffer = this.accumulator.getInputBuffer(i);
        this.device.queue.writeBuffer(
          this.inputBuffer,
          this.inputBufferWriteOffset * 4, // byte offset
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength
        );
        this.inputBufferWriteOffset += blockSize;
      }
    }

    // Copy the current block into the input buffer
    const buffer = this.accumulator.getInputBuffer(blockIndex);
    this.device.queue.writeBuffer(
      this.inputBuffer,
      this.inputBufferWriteOffset * 4, // byte offset
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength
    );
    this.inputBufferWriteOffset += samplesNeeded;
  }

  /**
   * Reset the transformer to initial state
   */
  reset(): void {
    this.accumulator.reset();
    this.inputBufferWriteOffset = 0;
    this.lastProcessedBlockIndex = -1;
  }

  /**
   * Cleanup and destroy WebGPU resources
   */
  destroy(): void {
    this.inputBuffer.destroy();
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
