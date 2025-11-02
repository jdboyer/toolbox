import type { Accumulator } from "./accumulator.ts";
import { RingBuffer } from "./ring-buffer.ts";
import { WaveletTransform, type WaveletTransformConfig } from "./wavelet-transform.ts";

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
 *
 * To compute 128 frames with hopLength=256 and maxKernelLength=24686:
 * Required samples = (numFrames - 1) * hopLength + maxKernelLength
 *                  = (128 - 1) * 256 + 24686 = 57,198
 * Rounded up to power of 2: 65,536
 *
 * Input buffer overlap is set to maxKernelLength to ensure continuity:
 * - Each CQT frame requires maxKernelLength samples
 * - Overlapping by this amount ensures no gaps between batches
 * - This maintains time-frequency continuity across output buffers
 */
const DEFAULT_CONFIG: TransformerConfig = {
  inputBufferSize: 65536,
  inputBufferCount: 2,
  inputBufferOverlap: 24686,  // maxKernelLength - ensures continuous CQT computation across batches
  frequencyBinCount: 1024,
  timeSliceCount: 128,
  outputBufferCount: 4,
};

/**
 * Transformer - Processes audio blocks from the Accumulator
 *
 * The Transformer receives a reference to the Accumulator and processes
 * filled blocks in order, marking them as processed when complete.
 * It manages three ring buffers of WebGPU resources:
 * - Input ring buffer: Contains audio sample data (float arrays)
 * - Output ring buffer: Contains frequency transform results (2D arrays: freq bins x time)
 * - Texture ring buffer: Contains 2D textures for visualization (same dimensions as output)
 */
export class Transformer {
  private device: GPUDevice;
  private accumulator: Accumulator;
  private config: TransformerConfig;

  // Ring buffer for input audio sample buffers
  private inputBufferRing: RingBuffer<GPUBuffer>;

  // Ring buffer for output frequency transform buffers
  private outputBufferRing: RingBuffer<GPUBuffer>;

  // Track the number of valid frames in each output buffer (for partial batches)
  private outputFrameCounts: Uint32Array;

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

    // Create wavelet transform for CQT computation FIRST (needed for buffer/texture creation)
    // TODO: Make these configurable via TransformerConfig
    const waveletConfig: WaveletTransformConfig = {
      sampleRate: 48000, // Default sample rate
      fmin: 32.7, // C1
      fmax: 16000, // Upper frequency limit
      binsPerOctave: 12,
      hopLength: 256, // Fixed hop length to match reference CQT
    };
    this.waveletTransform = new WaveletTransform(this.device, waveletConfig);

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

    // Initialize frame count tracking for output buffers
    this.outputFrameCounts = new Uint32Array(this.config.outputBufferCount);
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
    // Output is a 2D array: numFrames x numBins (column-major)
    // Use the actual number of bins from the CQT, not the config
    const actualNumBins = this.waveletTransform.getNumBins();
    const numFrames = this.config.timeSliceCount;

    // Calculate bytes per row with 256-byte alignment (required for buffer-to-texture)
    const bytesPerRow = Math.ceil((actualNumBins * Float32Array.BYTES_PER_ELEMENT) / 256) * 256;
    const byteSize = bytesPerRow * numFrames;

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
      this.outputFrameCounts = new Uint32Array(this.config.outputBufferCount);
    }
  }

  /**
   * Reset transformer state to initial conditions
   * Clears all buffers and resets ring buffer indices
   */
  reset(): void {
    // Reset active buffer tracking
    this.activeInputBufferIndex = 0;
    this.activeInputBufferOffset = 0;

    // Clear staging buffer
    this.stagingBuffer.fill(0);

    // Reset frame counts
    this.outputFrameCounts.fill(0);

    // Reset all ring buffers
    this.inputBufferRing.reset();
    this.outputBufferRing.reset();

    // Note: We don't need to clear the GPU buffers themselves
    // as they will be overwritten when new data is processed
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
      console.log("No blocks to process (processBlockIndex=-1)");
      return;
    }

    const lastValidBlockIndex = this.accumulator.getLastValidBlockIndex();
    const maxBlocks = this.accumulator.getMaxBlocks();

    console.log(`Processing blocks: processBlockIndex=${processBlockIndex}, lastValidBlockIndex=${lastValidBlockIndex}, maxBlocks=${maxBlocks}`);

    // Start from the first unprocessed block
    let currentBlockIndex = processBlockIndex;

    // Iterate through all unprocessed blocks
    let blocksProcessed = 0;
    let transformsRun = 0;
    while (true) {
      // Get the block data from accumulator
      const blockData = this.accumulator.getBlock(currentBlockIndex);

      // Check if adding this block would overflow the buffer
      const blockSize = blockData.length;
      if (this.activeInputBufferOffset + blockSize > this.config.inputBufferSize) {
        // Not enough space - run transform and move to next buffer first
        console.log(`Input buffer would overflow (${this.activeInputBufferOffset} + ${blockSize} > ${this.config.inputBufferSize}). Running transform...`);
        this.doTransform();
        transformsRun++;
        this.nextInputBuffer();
      }

      // Copy samples from this block into the active input buffer
      this.copySamplesToInputBuffer(blockData);
      blocksProcessed++;

      // Check if we've processed all blocks up to lastValidBlockIndex
      if (currentBlockIndex === lastValidBlockIndex) {
        // This is the last block - run transform one final time with whatever data we have
        console.log(`Last block reached. Running final transform with ${this.activeInputBufferOffset} samples`);
        this.doTransform();
        transformsRun++;
        break;
      }

      // Move to next block (with wrapping)
      currentBlockIndex = (currentBlockIndex + 1) % maxBlocks;
    }

    console.log(`Processed ${blocksProcessed} blocks, ran ${transformsRun} transforms`);

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
   * Computes ALL possible frames from the buffer, creating multiple textures if needed
   * This ensures continuous time coverage with no gaps
   */
  private doTransform(): void {
    // Audio length is the current offset (how much we've filled so far)
    const audioLength = this.activeInputBufferOffset;

    // Get parameters from the wavelet transform (single source of truth)
    const hopLength = this.waveletTransform.getHopLength();
    const maxKernelLength = this.waveletTransform.getMaxKernelLength();

    // Skip transform if we don't have enough audio data
    if (audioLength < maxKernelLength) {
      console.log(`Skipping transform: audioLength=${audioLength} < maxKernelLength=${maxKernelLength}`);
      return;
    }

    // Calculate total frames we can compute from this buffer
    const totalFrames = Math.floor((audioLength - maxKernelLength) / hopLength) + 1;

    if (totalFrames <= 0) {
      console.log(`Skipping transform: totalFrames=${totalFrames}`);
      return;
    }

    console.log(`Running transform: audioLength=${audioLength}, totalFrames=${totalFrames}, will create ${Math.ceil(totalFrames / this.config.timeSliceCount)} texture(s)`);

    // CRITICAL: Write the staging buffer to GPU BEFORE running the transform
    // Otherwise we'd be transforming an empty buffer!
    const inputBuffer = this.inputBufferRing.getBuffer(this.activeInputBufferIndex);
    this.device.queue.writeBuffer(
      inputBuffer,
      0,
      this.stagingBuffer.buffer,
      this.stagingBuffer.byteOffset,
      this.stagingBuffer.byteLength
    );

    // Process frames in batches of timeSliceCount (128)
    let frameOffset = 0;
    while (frameOffset < totalFrames) {
      const numFrames = Math.min(this.config.timeSliceCount, totalFrames - frameOffset);

      // Get the output buffer for this batch
      const outputBuffer = this.outputBufferRing.getWriteBuffer();
      const outputBufferIndex = this.outputBufferRing.getWriteIndex();

      console.log(`  Batch: frameOffset=${frameOffset}, numFrames=${numFrames}, bufferIndex=${outputBufferIndex}`);

      // Create command encoder for this transform
      const commandEncoder = this.device.createCommandEncoder({
        label: `wavelet-transform-commands-offset-${frameOffset}`,
      });

      // Dispatch the CQT compute shader with frame offset
      this.waveletTransform.computeTransform(
        inputBuffer,
        outputBuffer,
        audioLength,
        numFrames,
        commandEncoder,
        frameOffset,
      );

      // Submit the commands (no need to copy to texture anymore)
      this.device.queue.submit([commandEncoder.finish()]);

      // Store the actual frame count for this output buffer
      this.outputFrameCounts[outputBufferIndex] = numFrames;

      // Advance output buffer ring write index
      this.outputBufferRing.advanceWrite();

      // Move to next batch
      frameOffset += numFrames;
    }
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
   * Get the frame counts for each output buffer (how many valid frames each buffer contains)
   */
  getOutputFrameCounts(): Uint32Array {
    return this.outputFrameCounts;
  }

  /**
   * Get the wavelet transform instance
   */
  getWaveletTransform(): WaveletTransform {
    return this.waveletTransform;
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
