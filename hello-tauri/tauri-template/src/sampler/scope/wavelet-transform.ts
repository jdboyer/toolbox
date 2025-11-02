/**
 * WebGPU-based Wavelet Transform (CQT) for real-time audio analysis
 *
 * This module provides GPU-accelerated Constant-Q Transform computation
 * optimized for use in the audio analyzer pipeline. Unlike the standalone
 * CQT implementation, this keeps data on the GPU for real-time processing.
 */

/**
 * Configuration for the wavelet transform
 */
export interface WaveletTransformConfig {
  /** Sample rate in Hz */
  sampleRate: number;
  /** Minimum frequency in Hz */
  fmin: number;
  /** Maximum frequency in Hz */
  fmax: number;
  /** Number of bins per octave */
  binsPerOctave: number;
  /** Hop length in samples between consecutive frames */
  hopLength: number;
  /** Window scaling factor */
  windowScale?: number;
  /** Sparsity threshold */
  threshold?: number;
}

/**
 * Kernel data for CQT computation
 */
interface CQTKernel {
  kernelData: Float32Array;
  kernelLengths: Uint32Array;
  frequencies: Float32Array;
  numBins: number;
  maxKernelLength: number;
}

/**
 * Generate CQT kernels (basis functions)
 */
function generateCQTKernels(config: WaveletTransformConfig): CQTKernel {
  const {
    sampleRate,
    fmin,
    fmax,
    binsPerOctave,
    windowScale = 1.0,
    threshold = 0.0054,
  } = config;

  // Calculate number of bins
  const numBins = Math.ceil(binsPerOctave * Math.log2(fmax / fmin));

  // Calculate Q (quality factor)
  const Q = 1.0 / (Math.pow(2, 1.0 / binsPerOctave) - 1);

  // Generate frequency bins
  const frequencies = new Float32Array(numBins);
  for (let k = 0; k < numBins; k++) {
    frequencies[k] = fmin * Math.pow(2, k / binsPerOctave);
  }

  // Calculate kernel lengths
  const kernelLengths = new Uint32Array(numBins);
  let maxKernelLength = 0;

  for (let k = 0; k < numBins; k++) {
    const freq = frequencies[k];
    const length = Math.ceil((Q * sampleRate * windowScale) / freq);
    kernelLengths[k] = length;
    maxKernelLength = Math.max(maxKernelLength, length);
  }

  // Generate kernels (complex exponentials with Hamming window)
  const kernelData = new Float32Array(numBins * maxKernelLength * 2);

  for (let k = 0; k < numBins; k++) {
    const freq = frequencies[k];
    const length = kernelLengths[k];
    const offset = k * maxKernelLength * 2;

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
  floatsPerRow: u32,  // Number of floats per row (including padding)
}

@group(0) @binding(0) var<storage, read> audioData: array<f32>;
@group(0) @binding(1) var<storage, read> kernelData: array<f32>;
@group(0) @binding(2) var<storage, read> kernelLengths: array<u32>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;
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

  // Store with row padding: output[frame * floatsPerRow + bin]
  // floatsPerRow includes padding to meet 256-byte alignment
  output[frame * params.floatsPerRow + bin] = magnitude;
}
`;

/**
 * WaveletTransform manages GPU resources for real-time CQT computation
 */
export class WaveletTransform {
  private device: GPUDevice;
  private config: WaveletTransformConfig;
  private kernel: CQTKernel;

  // GPU resources
  private kernelBuffer: GPUBuffer;
  private kernelLengthsBuffer: GPUBuffer;
  private paramsBuffer: GPUBuffer;
  private pipeline: GPUComputePipeline;
  private bindGroupLayout: GPUBindGroupLayout;

  /**
   * Create a WaveletTransform instance
   */
  constructor(device: GPUDevice, config: WaveletTransformConfig) {
    this.device = device;
    this.config = config;
    this.kernel = generateCQTKernels(config);

    // Create persistent GPU buffers for kernel data
    this.kernelBuffer = this.createKernelBuffer();
    this.kernelLengthsBuffer = this.createKernelLengthsBuffer();
    this.paramsBuffer = this.createParamsBuffer();

    // Create compute pipeline
    const { pipeline, bindGroupLayout } = this.createPipeline();
    this.pipeline = pipeline;
    this.bindGroupLayout = bindGroupLayout;
  }

  /**
   * Create and upload kernel data buffer
   */
  private createKernelBuffer(): GPUBuffer {
    const buffer = this.device.createBuffer({
      label: "wavelet-kernel-data",
      size: this.kernel.kernelData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(buffer.getMappedRange()).set(this.kernel.kernelData);
    buffer.unmap();
    return buffer;
  }

  /**
   * Create and upload kernel lengths buffer
   */
  private createKernelLengthsBuffer(): GPUBuffer {
    const buffer = this.device.createBuffer({
      label: "wavelet-kernel-lengths",
      size: this.kernel.kernelLengths.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(buffer.getMappedRange()).set(this.kernel.kernelLengths);
    buffer.unmap();
    return buffer;
  }

  /**
   * Create uniform buffer for parameters (will be updated per transform)
   */
  private createParamsBuffer(): GPUBuffer {
    return this.device.createBuffer({
      label: "wavelet-params",
      size: 6 * 4, // 6 u32 values (numBins, numFrames, hopLength, maxKernelLength, audioLength, floatsPerRow)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Create compute pipeline
   */
  private createPipeline(): {
    pipeline: GPUComputePipeline;
    bindGroupLayout: GPUBindGroupLayout;
  } {
    const shaderModule = this.device.createShaderModule({
      label: "wavelet-cqt-shader",
      code: CQT_SHADER,
    });

    const pipeline = this.device.createComputePipeline({
      label: "wavelet-cqt-pipeline",
      layout: "auto",
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
    });

    const bindGroupLayout = pipeline.getBindGroupLayout(0);

    return { pipeline, bindGroupLayout };
  }

  /**
   * Compute CQT transform
   * @param inputBuffer GPU buffer containing audio samples
   * @param outputBuffer GPU buffer to store magnitude results
   * @param audioLength Number of audio samples in the input buffer
   * @param numFrames Number of time frames to compute
   * @param commandEncoder Command encoder to record commands into
   */
  computeTransform(
    inputBuffer: GPUBuffer,
    outputBuffer: GPUBuffer,
    audioLength: number,
    numFrames: number,
    commandEncoder: GPUCommandEncoder,
  ): void {
    // Calculate floatsPerRow (256-byte aligned rows)
    const bytesPerRow = Math.ceil((this.kernel.numBins * 4) / 256) * 256;
    const floatsPerRow = bytesPerRow / 4;

    // Update parameters
    const paramsData = new Uint32Array([
      this.kernel.numBins,
      numFrames,
      this.config.hopLength,
      this.kernel.maxKernelLength,
      audioLength,
      floatsPerRow,
    ]);
    this.device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);

    // Create bind group for this transform
    const bindGroup = this.device.createBindGroup({
      label: "wavelet-transform-bind-group",
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: inputBuffer } },
        { binding: 1, resource: { buffer: this.kernelBuffer } },
        { binding: 2, resource: { buffer: this.kernelLengthsBuffer } },
        { binding: 3, resource: { buffer: outputBuffer } },
        { binding: 4, resource: { buffer: this.paramsBuffer } },
      ],
    });

    // Begin compute pass
    const passEncoder = commandEncoder.beginComputePass({
      label: "wavelet-cqt-pass",
    });
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, bindGroup);

    // Dispatch workgroups
    const workgroupsX = Math.ceil(this.kernel.numBins / 8);
    const workgroupsY = Math.ceil(numFrames / 8);
    passEncoder.dispatchWorkgroups(workgroupsX, workgroupsY);
    passEncoder.end();
  }

  /**
   * Get the number of frequency bins
   */
  getNumBins(): number {
    return this.kernel.numBins;
  }

  /**
   * Get the frequencies for each bin
   */
  getFrequencies(): Float32Array {
    return this.kernel.frequencies;
  }

  /**
   * Get the maximum kernel length
   */
  getMaxKernelLength(): number {
    return this.kernel.maxKernelLength;
  }

  /**
   * Get the hop length
   */
  getHopLength(): number {
    return this.config.hopLength;
  }

  /**
   * Cleanup GPU resources
   */
  destroy(): void {
    this.kernelBuffer.destroy();
    this.kernelLengthsBuffer.destroy();
    this.paramsBuffer.destroy();
  }
}
