/**
 * WebGPU-based Constant-Q Transform (CQT)
 *
 * This module provides a GPU-accelerated implementation of the Constant-Q Transform
 * for audio analysis. The CQT provides logarithmically-spaced frequency bins,
 * making it ideal for music and audio analysis.
 */

/**
 * Configuration interface for the Constant-Q Transform
 */
export interface CQTConfig {
  /** Sample rate of the input audio in Hz */
  sampleRate: number;

  /** Minimum frequency in Hz (default: 32.7 Hz, ~C1) */
  fmin: number;

  /** Maximum frequency in Hz (default: sampleRate/2) */
  fmax?: number;

  /** Number of bins per octave (default: 12 for semitones) */
  binsPerOctave: number;

  /** Hop length in samples between consecutive CQT columns (default: 512) */
  hopLength: number;

  /** Window length scaling factor (default: 1.0) */
  windowScale?: number;

  /** Threshold for kernel sparsity (default: 0.0054, ~-45dB) */
  threshold?: number;
}

/**
 * Result from the CQT transform
 */
export interface CQTResult {
  /** 2D matrix of magnitudes: [numBins x numFrames] */
  magnitudes: Float32Array;

  /** Number of frequency bins */
  numBins: number;

  /** Number of time frames */
  numFrames: number;

  /** Frequency of each bin in Hz */
  frequencies: Float32Array;

  /** Time of first frame in seconds */
  timeStart: number;

  /** Time of last frame in seconds */
  timeEnd: number;

  /** Time step between frames in seconds */
  timeStep: number;
}

/**
 * Internal kernel data for CQT computation
 */
interface CQTKernel {
  /** Complex kernel data (real, imag interleaved) */
  kernelData: Float32Array;

  /** Length of each kernel */
  kernelLengths: Uint32Array;

  /** Center frequencies */
  frequencies: Float32Array;

  /** Number of bins */
  numBins: number;

  /** Maximum kernel length */
  maxKernelLength: number;
}

/**
 * Generate the CQT kernels (basis functions) for the transform
 */
function generateCQTKernels(config: CQTConfig): CQTKernel {
  const {
    sampleRate,
    fmin,
    binsPerOctave,
    windowScale = 1.0,
    threshold = 0.0054,
  } = config;

  const fmax = config.fmax ?? sampleRate / 2;

  // Calculate number of bins
  const numBins = Math.ceil(binsPerOctave * Math.log2(fmax / fmin));

  // Calculate Q (quality factor)
  const Q = 1.0 / (Math.pow(2, 1.0 / binsPerOctave) - 1);

  // Generate frequency bins
  const frequencies = new Float32Array(numBins);
  for (let k = 0; k < numBins; k++) {
    frequencies[k] = fmin * Math.pow(2, k / binsPerOctave);
  }

  // Calculate kernel lengths for each bin
  const kernelLengths = new Uint32Array(numBins);
  let maxKernelLength = 0;

  for (let k = 0; k < numBins; k++) {
    const freq = frequencies[k];
    const length = Math.ceil((Q * sampleRate * windowScale) / freq);
    kernelLengths[k] = length;
    maxKernelLength = Math.max(maxKernelLength, length);
  }

  // Generate kernels (complex exponentials with window)
  // Store as [bin0_real, bin0_imag, bin1_real, bin1_imag, ...]
  // Each kernel padded to maxKernelLength
  const kernelData = new Float32Array(numBins * maxKernelLength * 2);

  for (let k = 0; k < numBins; k++) {
    const freq = frequencies[k];
    const length = kernelLengths[k];
    const offset = k * maxKernelLength * 2;

    // Generate Hamming-windowed complex exponential
    for (let n = 0; n < length; n++) {
      // Hamming window
      const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (length - 1));

      // Complex exponential: e^(-2πi * freq * n / sampleRate)
      const phase = -2 * Math.PI * freq * n / sampleRate;
      const real = window * Math.cos(phase);
      const imag = window * Math.sin(phase);

      // Apply threshold
      if (Math.abs(real) > threshold || Math.abs(imag) > threshold) {
        kernelData[offset + n * 2] = real;
        kernelData[offset + n * 2 + 1] = imag;
      }
    }

    // Normalize kernel
    let normFactor = 0;
    for (let n = 0; n < length; n++) {
      const real = kernelData[offset + n * 2];
      const imag = kernelData[offset + n * 2 + 1];
      normFactor += real * real + imag * imag;
    }
    normFactor = Math.sqrt(normFactor);

    if (normFactor > 0) {
      for (let n = 0; n < length; n++) {
        kernelData[offset + n * 2] /= normFactor;
        kernelData[offset + n * 2 + 1] /= normFactor;
      }
    }
  }

  return {
    kernelData,
    kernelLengths,
    frequencies,
    numBins,
    maxKernelLength,
  };
}

/**
 * WebGPU compute shader for CQT calculation
 */
const CQT_SHADER = `
struct Params {
  numBins: u32,
  numFrames: u32,
  hopLength: u32,
  maxKernelLength: u32,
  audioLength: u32,
}

@group(0) @binding(0) var<storage, read> audioData: array<f32>;
@group(0) @binding(1) var<storage, read> kernelData: array<f32>;  // Interleaved real, imag
@group(0) @binding(2) var<storage, read> kernelLengths: array<u32>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;  // Magnitudes
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let bin = global_id.x;
  let frame = global_id.y;

  if (bin >= params.numBins || frame >= params.numFrames) {
    return;
  }

  let kernelLength = kernelLengths[bin];
  let frameStart = frame * params.hopLength;

  var sumReal: f32 = 0.0;
  var sumImag: f32 = 0.0;

  // Convolve audio with kernel
  for (var n: u32 = 0u; n < kernelLength; n = n + 1u) {
    let audioIdx = frameStart + n;
    if (audioIdx >= params.audioLength) {
      break;
    }

    let audioSample = audioData[audioIdx];
    let kernelOffset = bin * params.maxKernelLength * 2u + n * 2u;
    let kernelReal = kernelData[kernelOffset];
    let kernelImag = kernelData[kernelOffset + 1u];

    sumReal += audioSample * kernelReal;
    sumImag += audioSample * kernelImag;
  }

  // Compute magnitude
  let magnitude = sqrt(sumReal * sumReal + sumImag * sumImag);

  // Store in column-major order: output[frame * numBins + bin]
  output[frame * params.numBins + bin] = magnitude;
}
`;

/**
 * Compute the Constant-Q Transform of audio data using WebGPU
 *
 * @param audioData - Mono audio samples (Float32Array)
 * @param config - CQT configuration parameters
 * @returns CQT result with magnitude matrix and metadata
 */
export async function computeCQT(
  audioData: Float32Array,
  config: CQTConfig,
): Promise<CQTResult> {
  // Generate kernels
  const kernel = generateCQTKernels(config);

  // Calculate number of frames
  const numFrames = Math.floor(
    (audioData.length - kernel.maxKernelLength) / config.hopLength
  ) + 1;

  // Initialize WebGPU
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    throw new Error("WebGPU is not supported on this system");
  }

  const device = await adapter.requestDevice();

  // Create buffers
  const audioBuffer = device.createBuffer({
    size: audioData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Float32Array(audioBuffer.getMappedRange()).set(audioData);
  audioBuffer.unmap();

  const kernelBuffer = device.createBuffer({
    size: kernel.kernelData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Float32Array(kernelBuffer.getMappedRange()).set(kernel.kernelData);
  kernelBuffer.unmap();

  const kernelLengthsBuffer = device.createBuffer({
    size: kernel.kernelLengths.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint32Array(kernelLengthsBuffer.getMappedRange()).set(kernel.kernelLengths);
  kernelLengthsBuffer.unmap();

  const outputSize = kernel.numBins * numFrames * 4; // Float32
  const outputBuffer = device.createBuffer({
    size: outputSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const readbackBuffer = device.createBuffer({
    size: outputSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // Create uniform buffer for parameters
  const paramsData = new Uint32Array([
    kernel.numBins,
    numFrames,
    config.hopLength,
    kernel.maxKernelLength,
    audioData.length,
  ]);
  const paramsBuffer = device.createBuffer({
    size: paramsData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint32Array(paramsBuffer.getMappedRange()).set(paramsData);
  paramsBuffer.unmap();

  // Create shader module and pipeline
  const shaderModule = device.createShaderModule({ code: CQT_SHADER });

  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: {
      module: shaderModule,
      entryPoint: "main",
    },
  });

  // Create bind group
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: audioBuffer } },
      { binding: 1, resource: { buffer: kernelBuffer } },
      { binding: 2, resource: { buffer: kernelLengthsBuffer } },
      { binding: 3, resource: { buffer: outputBuffer } },
      { binding: 4, resource: { buffer: paramsBuffer } },
    ],
  });

  // Execute compute shader
  const commandEncoder = device.createCommandEncoder();
  const passEncoder = commandEncoder.beginComputePass();
  passEncoder.setPipeline(pipeline);
  passEncoder.setBindGroup(0, bindGroup);

  // Dispatch workgroups
  const workgroupsX = Math.ceil(kernel.numBins / 8);
  const workgroupsY = Math.ceil(numFrames / 8);
  passEncoder.dispatchWorkgroups(workgroupsX, workgroupsY);
  passEncoder.end();

  // Copy output to readback buffer
  commandEncoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, outputSize);

  device.queue.submit([commandEncoder.finish()]);

  // Read results
  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const resultData = new Float32Array(readbackBuffer.getMappedRange());
  const magnitudes = new Float32Array(resultData);
  readbackBuffer.unmap();

  // Cleanup
  audioBuffer.destroy();
  kernelBuffer.destroy();
  kernelLengthsBuffer.destroy();
  outputBuffer.destroy();
  readbackBuffer.destroy();
  paramsBuffer.destroy();
  device.destroy();

  // Calculate time information
  const timeStep = config.hopLength / config.sampleRate;
  const timeStart = 0;
  const timeEnd = (numFrames - 1) * timeStep;

  return {
    magnitudes,
    numBins: kernel.numBins,
    numFrames,
    frequencies: kernel.frequencies,
    timeStart,
    timeEnd,
    timeStep,
  };
}

/**
 * Convert CQT result magnitudes to log scale (dB)
 */
export function magnitudesToDB(
  magnitudes: Float32Array,
  refValue: number = 1.0,
  minDB: number = -80,
): Float32Array {
  const result = new Float32Array(magnitudes.length);
  for (let i = 0; i < magnitudes.length; i++) {
    const db = 20 * Math.log10(Math.max(magnitudes[i], 1e-10) / refValue);
    result[i] = Math.max(db, minDB);
  }
  return result;
}
