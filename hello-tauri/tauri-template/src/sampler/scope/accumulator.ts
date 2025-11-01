/**
 * Accumulator - Manages audio sample data in a ring buffer
 *
 * The Accumulator maintains a ring buffer of fixed-size blocks that store
 * audio samples. It handles incoming sample data by filling blocks sequentially
 * and wrapping around when the buffer is full.
 */
export class Accumulator {
  private blockSize: number;
  private maxBlocks: number;
  private ringBuffer: Float32Array[];

  // Track which blocks contain valid (filled) data
  private firstValidBlockIndex: number;
  private lastValidBlockIndex: number;

  // Track the current block being written to
  private activeBlockIndex: number;
  private activeBlockOffset: number;

  // Track the first unprocessed block (-1 if all blocks are processed)
  private processBlockIndex: number;

  /**
   * Create an Accumulator instance
   * @param blockSize Number of samples per block
   * @param maxBlocks Maximum number of blocks in the ring buffer
   */
  constructor(blockSize: number, maxBlocks: number) {
    this.blockSize = blockSize;
    this.maxBlocks = maxBlocks;

    // Initialize ring buffer with empty Float32Arrays
    this.ringBuffer = new Array(maxBlocks);
    for (let i = 0; i < maxBlocks; i++) {
      this.ringBuffer[i] = new Float32Array(blockSize);
    }

    // Initialize tracking indices
    this.firstValidBlockIndex = -1;
    this.lastValidBlockIndex = -1;
    this.activeBlockIndex = 0;
    this.activeBlockOffset = 0;
    this.processBlockIndex = -1;
  }

  /**
   * Add samples to the accumulator
   * Samples are written to blocks sequentially, wrapping around when necessary
   * @param samples Audio samples to add
   */
  addSamples(samples: Float32Array): void {
    let sampleIndex = 0;
    const totalSamples = samples.length;

    while (sampleIndex < totalSamples) {
      const activeBlock = this.ringBuffer[this.activeBlockIndex];
      const remainingInBlock = this.blockSize - this.activeBlockOffset;
      const remainingSamples = totalSamples - sampleIndex;
      const samplesToWrite = Math.min(remainingInBlock, remainingSamples);

      // Copy samples into the active block
      activeBlock.set(
        samples.subarray(sampleIndex, sampleIndex + samplesToWrite),
        this.activeBlockOffset
      );

      sampleIndex += samplesToWrite;
      this.activeBlockOffset += samplesToWrite;

      // Check if we've filled the current block
      if (this.activeBlockOffset >= this.blockSize) {
        // Mark this block as valid
        if (this.firstValidBlockIndex === -1) {
          this.firstValidBlockIndex = this.activeBlockIndex;
        }
        this.lastValidBlockIndex = this.activeBlockIndex;

        // If all blocks have been processed, set the process block index to this newly filled block
        if (this.processBlockIndex === -1) {
          this.processBlockIndex = this.activeBlockIndex;
        }

        // Move to the next block
        this.activeBlockIndex = (this.activeBlockIndex + 1) % this.maxBlocks;
        this.activeBlockOffset = 0;

        // If we've wrapped around and are overwriting the first valid block,
        // advance the first valid block index
        if (this.activeBlockIndex === this.firstValidBlockIndex) {
          this.firstValidBlockIndex = (this.firstValidBlockIndex + 1) % this.maxBlocks;
        }
      }
    }
  }

  /**
   * Reset the accumulator to initial state
   * Clears all tracking indices and starts fresh
   * Note: Does not actually clear sample data, just resets indices
   */
  reset(): void {
    this.firstValidBlockIndex = -1;
    this.lastValidBlockIndex = -1;
    this.activeBlockIndex = 0;
    this.activeBlockOffset = 0;
    this.processBlockIndex = -1;
  }

  /**
   * Mark all blocks as processed
   * Sets the process block index to -1, indicating no blocks need processing
   */
  markProcessed(): void {
    this.processBlockIndex = -1;
  }

  /**
   * Get the number of samples per block
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
   * Get the index of the first valid block
   * @returns Block index or -1 if no valid blocks
   */
  getFirstValidBlockIndex(): number {
    return this.firstValidBlockIndex;
  }

  /**
   * Get the index of the last valid block
   * @returns Block index or -1 if no valid blocks
   */
  getLastValidBlockIndex(): number {
    return this.lastValidBlockIndex;
  }

  /**
   * Get the current active block index
   */
  getActiveBlockIndex(): number {
    return this.activeBlockIndex;
  }

  /**
   * Get the current offset within the active block
   */
  getActiveBlockOffset(): number {
    return this.activeBlockOffset;
  }

  /**
   * Get the process block index
   * @returns Block index of the first unprocessed block, or -1 if all blocks are processed
   */
  getProcessBlockIndex(): number {
    return this.processBlockIndex;
  }

  /**
   * Get a specific block from the ring buffer
   * @param index Block index
   * @returns Float32Array containing the block's samples
   */
  getBlock(index: number): Float32Array {
    if (index < 0 || index >= this.maxBlocks) {
      throw new Error(`Block index ${index} out of range [0, ${this.maxBlocks})`);
    }
    return this.ringBuffer[index];
  }
}
