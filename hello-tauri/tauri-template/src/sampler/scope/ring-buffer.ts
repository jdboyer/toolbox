/**
 * RingBuffer - Generic ring buffer abstraction for managing circular buffers
 *
 * This class provides:
 * 1. Automatic wrapping of indices in a circular buffer
 * 2. Tracking of current write position within a buffer
 * 3. Querying buffer ranges and status
 * 4. Lazy initialization of buffers using a factory function
 */
export class RingBuffer<T> {
  private buffers: T[];
  private bufferCount: number;
  private currentBufferIndex: number;
  private writeOffset: number;
  private bufferSize: number;
  private totalBuffersWritten: number;
  private bufferFactory: () => T;

  /**
   * Create a RingBuffer instance
   * @param bufferCount Number of buffers in the ring
   * @param bufferSize Size of each buffer (number of elements)
   * @param bufferFactory Callback function for creating new buffers
   */
  constructor(bufferCount: number, bufferSize: number, bufferFactory: () => T) {
    this.bufferCount = bufferCount;
    this.bufferSize = bufferSize;
    this.bufferFactory = bufferFactory;
    this.buffers = new Array(bufferCount);
    this.currentBufferIndex = 0;
    this.writeOffset = 0;
    this.totalBuffersWritten = 0;

    // Initialize all buffers using the factory
    for (let i = 0; i < bufferCount; i++) {
      this.buffers[i] = bufferFactory();
    }
  }

  /**
   * Get the current buffer being written to
   */
  getCurrentBuffer(): T {
    return this.buffers[this.currentBufferIndex];
  }

  /**
   * Get a buffer at a specific index (wraps around)
   * @param index Buffer index (will be wrapped to valid range)
   */
  getBuffer(index: number): T {
    const wrappedIndex = ((index % this.bufferCount) + this.bufferCount) % this.bufferCount;
    return this.buffers[wrappedIndex];
  }

  /**
   * Get the current buffer index
   */
  getCurrentBufferIndex(): number {
    return this.currentBufferIndex;
  }

  /**
   * Get the current write offset within the current buffer
   */
  getWriteOffset(): number {
    return this.writeOffset;
  }

  /**
   * Get the size of each buffer
   */
  getBufferSize(): number {
    return this.bufferSize;
  }

  /**
   * Get the number of buffers in the ring
   */
  getBufferCount(): number {
    return this.bufferCount;
  }

  /**
   * Get the total number of buffers written (not wrapped)
   */
  getTotalBuffersWritten(): number {
    return this.totalBuffersWritten;
  }

  /**
   * Advance the write offset by a given amount
   * If the offset exceeds the buffer size, advance to the next buffer
   * @param amount Number of elements to advance
   * @returns Number of complete buffers that were filled
   */
  advanceWriteOffset(amount: number): number {
    this.writeOffset += amount;
    let buffersCompleted = 0;

    while (this.writeOffset >= this.bufferSize) {
      this.writeOffset -= this.bufferSize;
      this.advanceBuffer();
      buffersCompleted++;
    }

    return buffersCompleted;
  }

  /**
   * Advance to the next buffer in the ring
   * Resets the write offset to 0
   */
  advanceBuffer(): void {
    this.currentBufferIndex = (this.currentBufferIndex + 1) % this.bufferCount;
    this.writeOffset = 0;
    this.totalBuffersWritten++;
  }

  /**
   * Get the remaining space in the current buffer
   */
  getRemainingSpace(): number {
    return this.bufferSize - this.writeOffset;
  }

  /**
   * Check if the current buffer is full
   */
  isCurrentBufferFull(): boolean {
    return this.writeOffset >= this.bufferSize;
  }

  /**
   * Check if the current buffer is empty
   */
  isCurrentBufferEmpty(): boolean {
    return this.writeOffset === 0;
  }

  /**
   * Get the range of valid buffer indices
   * If fewer than bufferCount buffers have been written, only returns written range
   * @returns { start: number, count: number } - start index and count of valid buffers
   */
  getValidBufferRange(): { start: number; count: number } {
    if (this.totalBuffersWritten < this.bufferCount) {
      // Not all buffers have been written yet
      return {
        start: 0,
        count: this.totalBuffersWritten,
      };
    } else {
      // Ring buffer is full, all buffers are valid
      // The oldest buffer is right after the current one
      const oldestIndex = (this.currentBufferIndex + 1) % this.bufferCount;
      return {
        start: oldestIndex,
        count: this.bufferCount,
      };
    }
  }

  /**
   * Get a range of buffers
   * @param startIndex Starting buffer index (will be wrapped)
   * @param count Number of buffers to retrieve
   * @returns Array of buffers
   */
  getBufferRange(startIndex: number, count: number): T[] {
    const result: T[] = [];
    for (let i = 0; i < count; i++) {
      result.push(this.getBuffer(startIndex + i));
    }
    return result;
  }

  /**
   * Reset the ring buffer to initial state
   * Optionally reinitialize all buffers using the factory
   * @param reinitializeBuffers If true, create new buffers using the factory
   */
  reset(reinitializeBuffers = false): void {
    this.currentBufferIndex = 0;
    this.writeOffset = 0;
    this.totalBuffersWritten = 0;

    if (reinitializeBuffers) {
      for (let i = 0; i < this.bufferCount; i++) {
        this.buffers[i] = this.bufferFactory();
      }
    }
  }

  /**
   * Get the absolute position across all buffers (buffer index + offset)
   * @returns Total number of elements written
   */
  getAbsolutePosition(): number {
    return this.totalBuffersWritten * this.bufferSize + this.writeOffset;
  }

  /**
   * Convert an absolute position to buffer index and offset
   * @param position Absolute position
   * @returns { bufferIndex: number, offset: number }
   */
  absoluteToBufferPosition(position: number): { bufferIndex: number; offset: number } {
    const bufferIndex = Math.floor(position / this.bufferSize);
    const offset = position % this.bufferSize;
    return { bufferIndex, offset };
  }
}
