/**
 * Common test helpers for WebGPU-based audio processing tests
 */

/**
 * Get a fresh WebGPU device for testing
 * Creates a NEW device for each call to prevent resource exhaustion and device loss issues
 * Tests should call this once and reuse the device within that test, then let it be garbage collected
 */
export async function getTestDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    throw new Error("WebGPU not supported - cannot get GPU adapter");
  }

  const device = await adapter.requestDevice();
  if (!device) {
    throw new Error("Failed to create WebGPU device");
  }

  return device;
}

/**
 * Read data from a GPU buffer
 * @param device WebGPU device
 * @param buffer GPU buffer to read from
 * @param byteOffset Offset in bytes (default: 0)
 * @param byteLength Length in bytes (default: entire buffer)
 * @returns Float32Array containing the buffer data
 */
export async function readGPUBuffer(
  device: GPUDevice,
  buffer: GPUBuffer,
  byteOffset: number = 0,
  byteLength?: number
): Promise<Float32Array> {
  const size = byteLength ?? buffer.size - byteOffset;

  // Create a staging buffer for reading
  const stagingBuffer = device.createBuffer({
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  // Copy from GPU buffer to staging buffer
  const commandEncoder = device.createCommandEncoder();
  commandEncoder.copyBufferToBuffer(buffer, byteOffset, stagingBuffer, 0, size);
  device.queue.submit([commandEncoder.finish()]);

  // Map and read the staging buffer
  // mapAsync will wait for all pending GPU operations to complete
  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const copyArrayBuffer = stagingBuffer.getMappedRange(0, size);
  const data = new Float32Array(copyArrayBuffer.slice(0));
  stagingBuffer.unmap();
  stagingBuffer.destroy();

  return data;
}

/**
 * Compare two Float32Arrays with a tolerance
 * @param actual Actual values
 * @param expected Expected values
 * @param tolerance Maximum allowed difference (default: 1e-6)
 * @returns Object with match status and details
 */
export function compareFloat32Arrays(
  actual: Float32Array,
  expected: Float32Array,
  tolerance: number = 1e-6
): { match: boolean; maxDiff: number; firstMismatchIndex: number } {
  if (actual.length !== expected.length) {
    return {
      match: false,
      maxDiff: Infinity,
      firstMismatchIndex: 0,
    };
  }

  let maxDiff = 0;
  let firstMismatchIndex = -1;

  for (let i = 0; i < actual.length; i++) {
    const diff = Math.abs(actual[i] - expected[i]);
    if (diff > maxDiff) {
      maxDiff = diff;
    }
    if (diff > tolerance && firstMismatchIndex === -1) {
      firstMismatchIndex = i;
    }
  }

  return {
    match: maxDiff <= tolerance,
    maxDiff,
    firstMismatchIndex,
  };
}

/**
 * Assert that two Float32Arrays are approximately equal
 * Throws an error if they don't match
 */
export function assertFloat32ArraysEqual(
  actual: Float32Array,
  expected: Float32Array,
  tolerance: number = 1e-6,
  message?: string
): void {
  const result = compareFloat32Arrays(actual, expected, tolerance);

  if (!result.match) {
    const prefix = message ? `${message}: ` : "";
    if (actual.length !== expected.length) {
      throw new Error(
        `${prefix}Arrays have different lengths: actual=${actual.length}, expected=${expected.length}`
      );
    }
    throw new Error(
      `${prefix}Arrays differ at index ${result.firstMismatchIndex}: ` +
        `actual[${result.firstMismatchIndex}]=${actual[result.firstMismatchIndex]}, ` +
        `expected[${result.firstMismatchIndex}]=${expected[result.firstMismatchIndex]}, ` +
        `maxDiff=${result.maxDiff}, tolerance=${tolerance}`
    );
  }
}

