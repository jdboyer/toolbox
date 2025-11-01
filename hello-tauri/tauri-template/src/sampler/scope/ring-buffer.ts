/**
 * RingBuffer - Generic ring buffer index management
 *
 * This class provides index management for circular buffers.
 * It tracks read/write positions and handles wrapping automatically.
 *
 * @template T The type of items stored in the ring buffer
 */
export class RingBuffer<T> {
  private buffers: T[];
  private capacity: number;
  private writeIndex: number;
  private readIndex: number;
  private count: number; // Number of items currently in buffer

  /**
   * Create a RingBuffer instance
   * @param capacity Maximum number of items in the ring buffer
   * @param initializer Function to create initial buffer items
   */
  constructor(capacity: number, initializer: (index: number) => T) {
    this.capacity = capacity;
    this.writeIndex = 0;
    this.readIndex = 0;
    this.count = 0;

    // Initialize buffers using the provided initializer function
    this.buffers = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.buffers[i] = initializer(i);
    }
  }

  /**
   * Get the capacity of the ring buffer
   */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Get the current number of items in the buffer
   */
  getCount(): number {
    return this.count;
  }

  /**
   * Check if the buffer is empty
   */
  isEmpty(): boolean {
    return this.count === 0;
  }

  /**
   * Check if the buffer is full
   */
  isFull(): boolean {
    return this.count === this.capacity;
  }

  /**
   * Get the current write index
   */
  getWriteIndex(): number {
    return this.writeIndex;
  }

  /**
   * Get the current read index
   */
  getReadIndex(): number {
    return this.readIndex;
  }

  /**
   * Get the buffer at a specific index
   * @param index Index into the ring buffer (0 to capacity-1)
   */
  getBuffer(index: number): T {
    if (index < 0 || index >= this.capacity) {
      throw new Error(`Index ${index} out of range [0, ${this.capacity})`);
    }
    return this.buffers[index];
  }

  /**
   * Get the buffer at the current write position
   */
  getWriteBuffer(): T {
    return this.buffers[this.writeIndex];
  }

  /**
   * Get the buffer at the current read position
   * @returns The buffer at read position, or null if buffer is empty
   */
  getReadBuffer(): T | null {
    if (this.isEmpty()) {
      return null;
    }
    return this.buffers[this.readIndex];
  }

  /**
   * Advance the write index
   * Increments the write position and wraps around if necessary
   * @returns The new write index
   */
  advanceWrite(): number {
    if (this.isFull()) {
      // If buffer is full, also advance read index (overwrite oldest)
      this.readIndex = (this.readIndex + 1) % this.capacity;
    } else {
      this.count++;
    }

    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    return this.writeIndex;
  }

  /**
   * Advance the read index
   * Increments the read position and wraps around if necessary
   * @returns The new read index, or -1 if buffer is empty
   */
  advanceRead(): number {
    if (this.isEmpty()) {
      return -1;
    }

    this.readIndex = (this.readIndex + 1) % this.capacity;
    this.count--;
    return this.readIndex;
  }

  /**
   * Reset the ring buffer to initial state
   * Clears all indices but does not destroy the buffer items
   */
  reset(): void {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.count = 0;
  }

  /**
   * Get all buffers (mainly for cleanup/destruction)
   */
  getAllBuffers(): T[] {
    return this.buffers;
  }

  /**
   * Execute a callback for each buffer in the ring
   * @param callback Function to execute for each buffer
   */
  forEach(callback: (buffer: T, index: number) => void): void {
    for (let i = 0; i < this.capacity; i++) {
      callback(this.buffers[i], i);
    }
  }
}
