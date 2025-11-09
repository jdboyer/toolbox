import { RingBuffer } from "./ring-buffer.ts";

/**
 * Callback function invoked when a block is prepared and ready for processing
 * @param inputOffset - The offset in the output buffer where the block starts
 */
export type ProcessCallback = (inputOffset: number) => void;

/**
 * Accumulator - Manages a ring buffer for accumulating audio samples
 *
 * This class is responsible for:
 * 1. Accumulating incoming audio samples into fixed-size blocks
 * 2. Managing a ring buffer of blocks for processing
 * 3. Tracking which blocks are ready for processing
 * 4. Managing WebGPU output buffer with automatic overflow handling
 */
export class Accumulator {
  private device: GPUDevice;
  private blockSize: number;
  private maxBlocks: number;
  private inputRingBuffer: RingBuffer<Float32Array>;

  // Output buffer management
  private outputBuffer: GPUBuffer;
  private outputBufferWriteOffset: number = 0;
  private readonly OUTPUT_BUFFER_SIZE = 4096 * 16; // samples
  private minWindowSize: number;
  private lastPreparedBlockIndex: number = -1;
  private waveletWindowSize: number = 1;

  private unprocessedBlocks: number = 0;

  // Callback for processing blocks
  private processCallback?: ProcessCallback;

  /**
   * Create an Accumulator instance
   * @param device Pre-initialized WebGPU device
   * @param blockSize Number of samples per block (default: 4096)
   * @param maxBlocks Maximum number of blocks in the ring buffer (default: 64)
   * @param minWindowSize Minimum number of samples needed for processing (e.g., CQT window size)
   * @param processCallback Optional callback invoked when a block is prepared
   */
  constructor(device: GPUDevice, blockSize = 4096, maxBlocks = 64, minWindowSize = 16384, processCallback?: ProcessCallback) {
    this.device = device;
    this.blockSize = blockSize;
    this.maxBlocks = maxBlocks;
    this.minWindowSize = minWindowSize;
    this.processCallback = processCallback;

    // Create ring buffer for input samples
    this.inputRingBuffer = new RingBuffer<Float32Array>(
      maxBlocks,
      blockSize,
      () => new Float32Array(blockSize)
    );

    // Create output buffer (4096 * 16 samples = 65536 * 4 bytes)
    this.outputBuffer = this.device.createBuffer({
      size: this.OUTPUT_BUFFER_SIZE * 4, // Float32 = 4 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
  }

  /**
   * Add samples to the accumulator
   * Samples are written to the ring buffer, automatically advancing buffers as needed
   * When blocks are completed, they are automatically prepared in the output buffer
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

      // Prepare output buffer for each completed block (max one block)
      if (completed > 0) {

        if (completed > 1) {
          console.error("Process 2 blocks at once!")
        }
        const totalBuffersWritten = this.inputRingBuffer.getTotalBuffersWritten();
        const currentBlockIndex = totalBuffersWritten - 1;

        // Prepare all newly completed blocks
        for (let i = this.lastPreparedBlockIndex + 1; i <= currentBlockIndex; i++) {
          this.prepareOutputBuffer(i);

        }

        this.lastPreparedBlockIndex = currentBlockIndex;
      }

      buffersCompleted += completed;
      samplesWritten += samplesToWrite;

      if (this.processCallback) {
        this.unprocessedBlocks += completed;
        const currentWriteOffset = this.getOutputBufferWriteOffset();
        const blocksRequired = Math.ceil(this.waveletWindowSize / this.blockSize);
        const blocksToProcess = Math.max(this.unprocessedBlocks - blocksRequired, 0);
        for (let i = 0; i < blocksToProcess; i++) { // Max one
          const blockInputOffset = currentWriteOffset - (this.unprocessedBlocks + i - 1) * this.blockSize;
            this.processCallback(blockInputOffset);
          }
        this.unprocessedBlocks -= blocksToProcess;
      }
    }

    // start here

    return buffersCompleted;

      //const blocksCompleted = this.accumulator.addSamples(chunk);

      // Process transform for each newly completed block
      // Need to calculate the inputOffset for each block before the accumulator offset changed
      //const currentWriteOffset = this.accumulator.getOutputBufferWriteOffset();
      //console.log(currentWriteOffset);
      //const blocksRequired = Math.ceil(this.waveletTransform.getMinWindowSize() / this.config.blockSize);
      //const blocksToProcess = Math.max(this.unprocessedBlocks - blocksRequired, 0);
      //for (let i = 0; i < blocksToProcess; i++) {
        //const blockInputOffset = currentWriteOffset - (this.unprocessedBlocks + i - 1) * this.config.blockSize;
        //this.processTransform(blockInputOffset);
      //}
      //this.unprocessedBlocks -= blocksToProcess;
  }

  /**
   * Prepare the output buffer with samples from a completed block
   * Handles buffer overflow by resetting and backfilling with previous blocks
   * @param blockIndex Index of the block to prepare
   */
  private prepareOutputBuffer(blockIndex: number): void {
    const samplesNeeded = this.blockSize;

    // Check if there's enough room in the output buffer
    if (this.outputBufferWriteOffset + samplesNeeded > this.OUTPUT_BUFFER_SIZE) {
      // Not enough room - reset buffer and backfill with previous blocks
      this.outputBufferWriteOffset = 0;

      // Calculate how many previous blocks we need to maintain at least minWindowSize
      const blocksNeeded = Math.ceil(this.minWindowSize / this.blockSize);
      const startBlockIndex = Math.max(0, blockIndex - blocksNeeded + 1);

      // Copy previous blocks to ensure we have enough context
      for (let i = startBlockIndex; i < blockIndex; i++) {
        const buffer = this.inputRingBuffer.getBuffer(i);
        this.device.queue.writeBuffer(
          this.outputBuffer,
          this.outputBufferWriteOffset * 4, // byte offset
          buffer
        );
        this.outputBufferWriteOffset += this.blockSize;
      }
    }

    // Copy the current block into the output buffer
    const buffer = this.inputRingBuffer.getBuffer(blockIndex);
    this.device.queue.writeBuffer(
      this.outputBuffer,
      this.outputBufferWriteOffset * 4, // byte offset
      buffer
    );

    // Calculate the input offset for this block before updating write offset
    //const inputOffset = this.outputBufferWriteOffset;
    this.outputBufferWriteOffset += samplesNeeded;

    // Invoke the callback if provided, passing the input offset
    //if (this.processCallback) {
      //this.processCallback(inputOffset);
    //}


  }

  /**
   * Reset the accumulator to initial state
   * Clears all buffers and resets indices
   */
  reset(): void {
    this.inputRingBuffer.reset(true); // Reinitialize buffers with zeros
    this.outputBufferWriteOffset = 0;
    this.lastPreparedBlockIndex = -1;

    // Clear the GPU output buffer by writing zeros
    const zeros = new Float32Array(this.OUTPUT_BUFFER_SIZE);
    this.device.queue.writeBuffer(this.outputBuffer, 0, zeros);
  }

  setMinSamples(n: number): void {
    this.waveletWindowSize = n;
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
   * Get the output buffer
   */
  getOutputBuffer(): GPUBuffer {
    return this.outputBuffer;
  }

  /**
   * Get the current write offset in the output buffer
   */
  getOutputBufferWriteOffset(): number {
    return this.outputBufferWriteOffset;
  }

  /**
   * Get the output buffer size in samples
   */
  getOutputBufferSize(): number {
    return this.OUTPUT_BUFFER_SIZE;
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

  /**
   * Cleanup and destroy WebGPU resources
   */
  destroy(): void {
    this.outputBuffer.destroy();
  }
}
