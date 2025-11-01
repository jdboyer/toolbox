import type { Accumulator } from "./accumulator";
import { RingBuffer } from "./ring-buffer";
import { WaveletTransform, type WaveletTransformConfig } from "./wavelet-transform";

/**
 * Configuration options for the Transformer
 */
export interface TransformerConfig {
  /** Number of samples per input buffer */
  inputBufferSize: number;
  /** Number of input buffers in the ring buffer */
  inputBufferCount: number;
  /** Number of samples to overlap between consecutive input buffers */
  inputBufferOverlap: number;
  /** Number of frequency bins in the output */
  frequencyBinCount: number;
  /** Number of time slices in each output buffer */
  timeSliceCount: number;
  /** Number of output buffers in the ring buffer */
  outputBufferCount: number;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: TransformerConfig = {
  inputBufferSize: 16384,
  inputBufferCount: 2,
  inputBufferOverlap: 4096,
  frequencyBinCount: 1024,
  timeSliceCount: 64,
  outputBufferCount: 4,
};

/**
 * Transformer - Processes audio blocks from the Accumulator
 *
 * The Transformer receives a reference to the Accumulator and processes
 * filled blocks in order, marking them as processed when complete.
 * It manages two ring buffers of WebGPU buffers:
 * - Input ring buffer: Contains audio sample data (float arrays)
 * - Output ring buffer: Contains frequency transform results (2D arrays: freq bins x time)
 */
export class Transformer {
  private device: GPUDevice;
  private accumulator: Accumulator;
  private config: TransformerConfig;

  // Ring buffer for input audio sample buffers
  private inputBufferRing: RingBuffer<GPUBuffer>;

  // Ring buffer for output frequency transform buffers
  private outputBufferRing: RingBuffer<GPUBuffer>;

  // Track the current active input buffer index and sample offset
  private activeInputBufferIndex: number;
  private activeInputBufferOffset: number;

  // Temporary staging buffer for copying samples to GPU
  private stagingBuffer: Float32Array;

  // Wavelet transform for CQT computation
  private waveletTransform: WaveletTransform;

  /**
   * Create a Transformer instance
   * @param device WebGPU device for creating buffers
   * @param accumulator Reference to the Accumulator instance
   */
  constructor(device: GPUDevice, accumulator: Accumulator) {
    this.device = device;
    this.accumulator = accumulator;
    this.config = { ...DEFAULT_CONFIG };

    // Initialize active input buffer tracking
    this.activeInputBufferIndex = 0;
    this.activeInputBufferOffset = 0;

    // Create staging buffer for copying samples to GPU
    this.stagingBuffer = new Float32Array(this.config.inputBufferSize);

    // Create input buffer ring (for audio samples)
    this.inputBufferRing = new RingBuffer<GPUBuffer>(
      this.config.inputBufferCount,
      (index) => this.createInputBuffer(index)
    );

    // Create output buffer ring (for frequency transform data)
    this.outputBufferRing = new RingBuffer<GPUBuffer>(
      this.config.outputBufferCount,
      (index) => this.createOutputBuffer(index)
    );

    // Create wavelet transform for CQT computation
    // TODO: Make these configurable via TransformerConfig
    const waveletConfig: WaveletTransformConfig = {
      sampleRate: 48000, // Default sample rate
      fmin: 32.7, // C1
      fmax: 16000, // Upper frequency limit
      binsPerOctave: 12,
      hopLength: Math.floor(this.config.inputBufferSize / this.config.timeSliceCount),
    };
    this.waveletTransform = new WaveletTransform(this.device, waveletConfig);
  }

  /**
   * Create a WebGPU buffer for input audio samples
   * @param index Buffer index (for labeling/debugging)
   */
  private createInputBuffer(index: number): GPUBuffer {
    const byteSize = this.config.inputBufferSize * Float32Array.BYTES_PER_ELEMENT;

    return this.device.createBuffer({
      label: `transformer-input-buffer-${index}`,
      size: byteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Create a WebGPU buffer for frequency transform output
   * @param index Buffer index (for labeling/debugging)
   */
  private createOutputBuffer(index: number): GPUBuffer {
    // Output is a 2D array: frequencyBinCount x timeSliceCount
    const elementCount = this.config.frequencyBinCount * this.config.timeSliceCount;
    const byteSize = elementCount * Float32Array.BYTES_PER_ELEMENT;

    return this.device.createBuffer({
      label: `transformer-output-buffer-${index}`,
      size: byteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
  }

  /**
   * Configure the transformer
   * @param config Partial configuration object (only specified fields will be updated)
   * Note: Changing buffer sizes or counts will destroy and recreate the ring buffers
   */
  configureTransformer(config: Partial<TransformerConfig>): void {
    const inputConfigChanged =
      (config.inputBufferSize !== undefined &&
        config.inputBufferSize !== this.config.inputBufferSize) ||
      (config.inputBufferCount !== undefined &&
        config.inputBufferCount !== this.config.inputBufferCount);

    const outputConfigChanged =
      (config.frequencyBinCount !== undefined &&
        config.frequencyBinCount !== this.config.frequencyBinCount) ||
      (config.timeSliceCount !== undefined &&
        config.timeSliceCount !== this.config.timeSliceCount) ||
      (config.outputBufferCount !== undefined &&
        config.outputBufferCount !== this.config.outputBufferCount);

    // Update configuration
    this.config = { ...this.config, ...config };

    // Recreate input buffers if configuration changed
    if (inputConfigChanged) {
      this.destroyInputBuffers();
      this.inputBufferRing = new RingBuffer<GPUBuffer>(
        this.config.inputBufferCount,
        (index) => this.createInputBuffer(index)
      );
    }

    // Recreate output buffers if configuration changed
    if (outputConfigChanged) {
      this.destroyOutputBuffers();
      this.outputBufferRing = new RingBuffer<GPUBuffer>(
        this.config.outputBufferCount,
        (index) => this.createOutputBuffer(index)
      );
    }
  }

  /**
   * Destroy all input buffers
   */
  private destroyInputBuffers(): void {
    this.inputBufferRing.forEach((buffer) => {
      buffer.destroy();
    });
  }

  /**
   * Destroy all output buffers
   */
  private destroyOutputBuffers(): void {
    this.outputBufferRing.forEach((buffer) => {
      buffer.destroy();
    });
  }

  /**
   * Process blocks from the accumulator
   * This method is called after new samples are added to the accumulator
   */
  processBlocks(): void {
    const processBlockIndex = this.accumulator.getProcessBlockIndex();

    // Early return if no blocks to process
    if (processBlockIndex === -1) {
      return;
    }

    const lastValidBlockIndex = this.accumulator.getLastValidBlockIndex();
    const maxBlocks = this.accumulator.getMaxBlocks();

    // Start from the first unprocessed block
    let currentBlockIndex = processBlockIndex;

    // Iterate through all unprocessed blocks
    while (true) {
      // Get the block data from accumulator
      const blockData = this.accumulator.getBlock(currentBlockIndex);

      // Copy samples from this block into the active input buffer
      this.copySamplesToInputBuffer(blockData);

      // Perform the wavelet transform on the active input buffer
      this.doTransform();

      // Check if the active input buffer is full after adding samples
      if (this.activeInputBufferOffset >= this.config.inputBufferSize) {
        this.nextInputBuffer();
      }

      // Check if we've processed all blocks up to lastValidBlockIndex
      if (currentBlockIndex === lastValidBlockIndex) {
        break;
      }

      // Move to next block (with wrapping)
      currentBlockIndex = (currentBlockIndex + 1) % maxBlocks;
    }

    // Mark all blocks as processed
    this.accumulator.markProcessed();
  }

  /**
   * Copy samples from accumulator block into the active input buffer
   * Assumes the entire block will fit in the current buffer
   * @param samples Audio samples from an accumulator block
   */
  private copySamplesToInputBuffer(samples: Float32Array): void {
    // Copy samples into staging buffer at the current offset
    this.stagingBuffer.set(samples, this.activeInputBufferOffset);
    this.activeInputBufferOffset += samples.length;
  }

  /**
   * Perform wavelet transform (CQT) on the active input buffer
   * Computes timeSliceCount CQTs with different offsets to populate one output buffer
   */
  private doTransform(): void {
    // Get the current input and output buffers
    const inputBuffer = this.inputBufferRing.getBuffer(this.activeInputBufferIndex);
    const outputBuffer = this.outputBufferRing.getWriteBuffer();

    // Calculate how many time frames to compute
    const numFrames = this.config.timeSliceCount;

    // Audio length is the current offset (how much we've filled so far)
    const audioLength = this.activeInputBufferOffset;

    // Create command encoder for this transform
    const commandEncoder = this.device.createCommandEncoder({
      label: "wavelet-transform-commands",
    });

    // Dispatch the CQT compute shader
    this.waveletTransform.computeTransform(
      inputBuffer,
      outputBuffer,
      audioLength,
      numFrames,
      commandEncoder,
    );

    // Submit the commands
    this.device.queue.submit([commandEncoder.finish()]);

    // Advance the output buffer ring write index
    this.outputBufferRing.advanceWrite();
  }

  /**
   * Transition to the next input buffer
   * Writes the current staging buffer to GPU, copies overlap region to next buffer
   */
  private nextInputBuffer(): void {
    // Write the full staging buffer to the GPU buffer
    const activeBuffer = this.inputBufferRing.getBuffer(this.activeInputBufferIndex);
    this.device.queue.writeBuffer(
      activeBuffer,
      0,
      this.stagingBuffer.buffer,
      this.stagingBuffer.byteOffset,
      this.stagingBuffer.byteLength
    );

    // Move to the next buffer in the ring
    this.activeInputBufferIndex = (this.activeInputBufferIndex + 1) % this.config.inputBufferCount;

    // Copy the overlap region from the end of the previous buffer to the start of the next
    const overlapStart = this.config.inputBufferSize - this.config.inputBufferOverlap;
    const overlapData = this.stagingBuffer.subarray(
      overlapStart,
      this.config.inputBufferSize
    );

    // Copy overlap to the beginning of the staging buffer
    this.stagingBuffer.set(overlapData, 0);

    // Set the offset to after the overlap region
    this.activeInputBufferOffset = this.config.inputBufferOverlap;
  }

  /**
   * Get the current configuration
   */
  getConfig(): TransformerConfig {
    return { ...this.config };
  }

  /**
   * Get the input buffer ring
   */
  getInputBufferRing(): RingBuffer<GPUBuffer> {
    return this.inputBufferRing;
  }

  /**
   * Get the output buffer ring
   */
  getOutputBufferRing(): RingBuffer<GPUBuffer> {
    return this.outputBufferRing;
  }

  /**
   * Cleanup and destroy all WebGPU resources
   * Should be called when the transformer is no longer needed
   */
  destroy(): void {
    this.destroyInputBuffers();
    this.destroyOutputBuffers();
    this.waveletTransform.destroy();
  }
}
