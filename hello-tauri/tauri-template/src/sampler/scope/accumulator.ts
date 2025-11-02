import { RingBuffer } from "./ring-buffer";

/**
 * Accumulator - Manages a ring buffer for accumulating audio samples
 *
 * This class is responsible for:
 * 1. Accumulating incoming audio samples into fixed-size blocks
 * 2. Managing a ring buffer of blocks for processing
 * 3. Tracking which blocks are ready for processing
 * 4. Creating and managing WebGPU storage buffers
 */
export class Accumulator {
  private device: GPUDevice;
  private blockSize: number;
  private maxBlocks: number;
  private inputRingBuffer: RingBuffer<Float32Array>;

  /**
   * Create an Accumulator instance
   * @param device Pre-initialized WebGPU device
   * @param blockSize Number of samples per block (default: 4096)
   * @param maxBlocks Maximum number of blocks in the ring buffer (default: 64)
   */
  constructor(device: GPUDevice, blockSize = 4096, maxBlocks = 64) {
    this.device = device;
    this.blockSize = blockSize;
    this.maxBlocks = maxBlocks;

    // Create ring buffer for input samples
    this.inputRingBuffer = new RingBuffer<Float32Array>(
      maxBlocks,
      blockSize,
      () => new Float32Array(blockSize)
    );
  }

  /**
   * Add samples to the accumulator
   * Samples are written to the ring buffer, automatically advancing buffers as needed
   * @param samples Float32Array containing audio samples
   * @returns Number of complete buffers that were filled
   */
  addSamples(samples: Float32Array): number {
    let samplesWritten = 0;
    let buffersCompleted = 0;

    while (samplesWritten < samples.length) {
      const remainingSpace = this.inputRingBuffer.getRemainingSpace();
      const remainingSamples = samples.length - samplesWritten;
      const samplesToWrite = Math.min(remainingSpace, remainingSamples);

      // Write samples to current buffer at current offset
      const writeOffset = this.inputRingBuffer.getWriteOffset();
      const currentBuffer = this.inputRingBuffer.getCurrentBuffer();
      currentBuffer.set(
        samples.subarray(samplesWritten, samplesWritten + samplesToWrite),
        writeOffset
      );

      // Advance the write offset
      const completed = this.inputRingBuffer.advanceWriteOffset(samplesToWrite);
      buffersCompleted += completed;
      samplesWritten += samplesToWrite;
    }

    return buffersCompleted;
  }

  /**
   * Reset the accumulator to initial state
   * Clears all buffers and resets indices
   */
  reset(): void {
    this.inputRingBuffer.reset(true); // Reinitialize buffers with zeros
  }

  /**
   * Get the block size
   */
  getBlockSize(): number {
    return this.blockSize;
  }

  /**
   * Get the maximum number of blocks
   */
  getMaxBlocks(): number {
    return this.maxBlocks;
  }

  /**
   * Get the WebGPU device
   */
  getDevice(): GPUDevice {
    return this.device;
  }

  /**
   * Get the input ring buffer
   */
  getInputRingBuffer(): RingBuffer<Float32Array> {
    return this.inputRingBuffer;
  }

  /**
   * Get a specific input buffer by index
   * @param index Buffer index (wraps around)
   */
  getInputBuffer(index: number): Float32Array {
    return this.inputRingBuffer.getBuffer(index);
  }

  /**
   * Get the current write position
   */
  getWritePosition(): { bufferIndex: number; offset: number } {
    return {
      bufferIndex: this.inputRingBuffer.getCurrentBufferIndex(),
      offset: this.inputRingBuffer.getWriteOffset(),
    };
  }

  /**
   * Get the total number of samples written
   */
  getTotalSamplesWritten(): number {
    return this.inputRingBuffer.getAbsolutePosition();
  }

  /**
   * Create a WebGPU storage buffer
   * @param size Size of the buffer in bytes
   * @param usage Additional usage flags (STORAGE is always included)
   * @returns GPUBuffer
   */
  createStorageBuffer(size: number, usage: GPUBufferUsageFlags = 0): GPUBuffer {
    return this.device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | usage,
    });
  }
}
