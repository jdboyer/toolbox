/**
 * WaveletTransform - Performs Constant-Q Transform (CQT) using WebGPU
 *
 * This class is responsible for:
 * 1. Computing CQT of audio data using WebGPU compute shaders
 * 2. Managing frequency-specific kernels
 * 3. Providing frequency-time analysis capabilities
 */

export interface CQTConfig {
  /** Sample rate in Hz */
  sampleRate: number;
  /** Minimum frequency (Hz) */
  fMin: number;
  /** Maximum frequency (Hz) */
  fMax: number;
  /** Number of frequency bins per octave */
  binsPerOctave: number;
  /** Block size in samples (must be power of 2, e.g., 4096) */
  blockSize: number;
  /** Batch factor - determines hop length and output columns (blockSize must be divisible by batchFactor) */
  batchFactor: number;
  /** Maximum number of blocks to store in the output buffer */
  maxBlocks: number;
}

interface CQTKernel {
  /** Center frequency for this kernel */
  frequency: number;
  /** Window length in samples */
  windowLength: number;
  /** Real part of complex kernel */
  real: Float32Array;
  /** Imaginary part of complex kernel */
  imag: Float32Array;
}

export class WaveletTransform {
  private device: GPUDevice;
  private config: CQTConfig;
  private kernels: CQTKernel[] = [];
  private numBins: number;
  private hopLength: number; // Calculated from blockSize / batchFactor

  // WebGPU resources
  private pipeline: GPUComputePipeline | null = null;
  private kernelBuffer: GPUBuffer | null = null;
  private kernelInfoBuffer: GPUBuffer | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  // Configuration state
  private configured: boolean = false;
  private configuredInputBuffer: GPUBuffer | null = null;
  private configuredInputLength: number = 0;
  private bindGroup: GPUBindGroup | null = null;
  private paramsBuffer: GPUBuffer | null = null;
  private maxKernelLength: number = 0;

  // Output buffer (owned by WaveletTransform)
  private outputBuffer: GPUBuffer | null = null;
  private maxTimeFrames: number = 0; // Total time frames that can be stored

  /**
   * Create a WaveletTransform instance
   * @param device WebGPU device
   * @param config CQT configuration
   */
  constructor(device: GPUDevice, config: CQTConfig) {
    this.device = device;
    this.config = config;

    // Validate blockSize is a power of 2
    if (!Number.isInteger(config.blockSize) || config.blockSize <= 0) {
      throw new Error(`blockSize must be a positive integer, got ${config.blockSize}`);
    }
    if ((config.blockSize & (config.blockSize - 1)) !== 0) {
      throw new Error(`blockSize must be a power of 2, got ${config.blockSize}`);
    }

    // Validate batchFactor
    if (!Number.isInteger(config.batchFactor) || config.batchFactor <= 0) {
      throw new Error(`batchFactor must be a positive integer, got ${config.batchFactor}`);
    }

    // Validate blockSize is divisible by batchFactor
    if (config.blockSize % config.batchFactor !== 0) {
      throw new Error(
        `blockSize (${config.blockSize}) must be evenly divisible by batchFactor (${config.batchFactor})`
      );
    }

    // Validate maxBlocks
    if (!Number.isInteger(config.maxBlocks) || config.maxBlocks <= 0) {
      throw new Error(`maxBlocks must be a positive integer, got ${config.maxBlocks}`);
    }

    // Calculate hop length
    this.hopLength = config.blockSize / config.batchFactor;

    // Calculate number of frequency bins
    const octaves = Math.log2(config.fMax / config.fMin);
    this.numBins = Math.ceil(octaves * config.binsPerOctave);

    // Calculate total time frames that can be stored
    // Each block produces batchFactor time frames (hops)
    this.maxTimeFrames = config.batchFactor * config.maxBlocks;

    // Generate kernels for each frequency bin
    this.generateKernels();

    // Initialize WebGPU resources
    this.initializeWebGPU();

    // Create output buffer (2D array: rows = time frames, columns = frequency bins)
    // Size: maxTimeFrames (rows) * numBins (columns) * 4 bytes per float
    this.outputBuffer = this.device.createBuffer({
      size: this.maxTimeFrames * this.numBins * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
  }

  /**
   * Generate CQT kernels for each frequency bin
   */
  private generateKernels(): void {
    this.kernels = [];

    const Q = 1 / (Math.pow(2, 1 / this.config.binsPerOctave) - 1);

    for (let k = 0; k < this.numBins; k++) {
      // Calculate center frequency for this bin
      const frequency = this.config.fMin * Math.pow(2, k / this.config.binsPerOctave);

      // Calculate window length based on Q factor
      const windowLength = Math.ceil((Q * this.config.sampleRate) / frequency);

      // Make sure window length is reasonable
      const clampedLength = Math.min(Math.max(windowLength, 32), 16384);

      // Generate complex kernel (Hamming-windowed complex exponential)
      const real = new Float32Array(clampedLength);
      const imag = new Float32Array(clampedLength);

      for (let n = 0; n < clampedLength; n++) {
        // Hamming window
        const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (clampedLength - 1));

        // Complex exponential: e^(-j*2*pi*f*n/sr)
        const phase = -2 * Math.PI * frequency * n / this.config.sampleRate;

        real[n] = window * Math.cos(phase);
        imag[n] = window * Math.sin(phase);
      }

      // Normalize kernel
      const norm = Math.sqrt(
        real.reduce((sum, val) => sum + val * val, 0) +
        imag.reduce((sum, val) => sum + val * val, 0)
      );

      for (let n = 0; n < clampedLength; n++) {
        real[n] /= norm;
        imag[n] /= norm;
      }

      this.kernels.push({
        frequency,
        windowLength: clampedLength,
        real,
        imag,
      });
    }
  }

  /**
   * Initialize WebGPU resources (buffers, shaders, pipeline)
   */
  private initializeWebGPU(): void {
    // Pack all kernels into contiguous buffers
    this.maxKernelLength = Math.max(...this.kernels.map(k => k.windowLength));
    const totalKernelSize = this.numBins * this.maxKernelLength * 2; // 2 for real+imag

    const packedKernels = new Float32Array(totalKernelSize);
    const kernelInfo = new Float32Array(this.numBins * 4); // [frequency, windowLength, offset, padding]

    for (let i = 0; i < this.kernels.length; i++) {
      const kernel = this.kernels[i];
      const baseOffset = i * this.maxKernelLength * 2;

      // Pack real parts
      packedKernels.set(kernel.real, baseOffset);
      // Pack imaginary parts
      packedKernels.set(kernel.imag, baseOffset + this.maxKernelLength);

      // Store kernel info
      kernelInfo[i * 4 + 0] = kernel.frequency;
      kernelInfo[i * 4 + 1] = kernel.windowLength;
      kernelInfo[i * 4 + 2] = baseOffset;
      kernelInfo[i * 4 + 3] = 0; // padding
    }

    // Create kernel buffer
    this.kernelBuffer = this.device.createBuffer({
      size: packedKernels.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.kernelBuffer, 0, packedKernels);

    // Create kernel info buffer
    this.kernelInfoBuffer = this.device.createBuffer({
      size: kernelInfo.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.kernelInfoBuffer, 0, kernelInfo);

    // Create bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" }, // Input audio buffer
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" }, // Output CQT buffer (2D)
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" }, // Kernel buffer
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" }, // Kernel info buffer
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" }, // Parameters
        },
      ],
    });

    // Create compute shader
    const shaderModule = this.device.createShaderModule({
      code: this.getCQTShader(this.maxKernelLength),
    });

    // Create pipeline
    this.pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
    });
  }

  /**
   * Generate WGSL shader code for CQT computation
   */
  private getCQTShader(maxKernelLength: number): string {
    return `
struct Params {
  inputOffset: u32,      // Offset into input buffer (samples)
  outputOffset: u32,     // Offset into output buffer (time frames)
  numBins: u32,          // Number of frequency bins
  maxKernelLength: u32,  // Maximum kernel length
  hopLength: u32,        // Hop length in samples
  numFrames: u32,        // Number of time frames to compute
  inputLength: u32,      // Length of input buffer
  padding: u32,
}

struct KernelInfo {
  frequency: f32,
  windowLength: f32,
  offset: f32,
  padding: f32,
}

@group(0) @binding(0) var<storage, read> inputBuffer: array<f32>;
@group(0) @binding(1) var<storage, read_write> outputBuffer: array<f32>;
@group(0) @binding(2) var<storage, read> kernelBuffer: array<f32>;
@group(0) @binding(3) var<storage, read> kernelInfo: array<KernelInfo>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let binIdx = globalId.x;
  let frameIdx = globalId.y;

  // Bounds check
  if (binIdx >= params.numBins || frameIdx >= params.numFrames) {
    return;
  }

  let info = kernelInfo[binIdx];
  let windowLength = u32(info.windowLength);
  let kernelOffset = u32(info.offset);

  // Calculate starting position in input buffer
  let inputStart = params.inputOffset + frameIdx * params.hopLength;

  // Check if we have enough samples
  if (inputStart + windowLength > params.inputLength) {
    return;
  }

  // Perform convolution: compute complex dot product
  var real_sum: f32 = 0.0;
  var imag_sum: f32 = 0.0;

  for (var n: u32 = 0u; n < windowLength; n = n + 1u) {
    let sample = inputBuffer[inputStart + n];
    let kernel_real = kernelBuffer[kernelOffset + n];
    let kernel_imag = kernelBuffer[kernelOffset + ${maxKernelLength}u + n];

    real_sum = real_sum + sample * kernel_real;
    imag_sum = imag_sum + sample * kernel_imag;
  }

  // Compute magnitude
  let magnitude = sqrt(real_sum * real_sum + imag_sum * imag_sum);

  // Write to output buffer (2D layout: [frame][bin])
  let outputIdx = (params.outputOffset + frameIdx) * params.numBins + binIdx;
  outputBuffer[outputIdx] = magnitude;
}
`;
  }

  /**
   * Configure the transform with input buffer
   * This should be called once before calling transform()
   * @param inputBuffer GPU buffer containing input audio samples
   * @param inputLength Total length of input buffer (in samples)
   */
  configure(
    inputBuffer: GPUBuffer,
    inputLength: number
  ): void {
    if (!this.pipeline || !this.bindGroupLayout || !this.kernelBuffer || !this.kernelInfoBuffer) {
      throw new Error("WaveletTransform not properly initialized");
    }

    if (!this.outputBuffer) {
      throw new Error("Output buffer not created");
    }

    // Clean up previous configuration if it exists
    if (this.paramsBuffer) {
      this.paramsBuffer.destroy();
      this.paramsBuffer = null;
    }

    // Store configuration
    this.configuredInputBuffer = inputBuffer;
    this.configuredInputLength = inputLength;

    // Create parameters buffer (will be updated during transform)
    this.paramsBuffer = this.device.createBuffer({
      size: 8 * 4, // 8 uint32 values
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group with the configured buffers
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: inputBuffer } },
        { binding: 1, resource: { buffer: this.outputBuffer } },
        { binding: 2, resource: { buffer: this.kernelBuffer } },
        { binding: 3, resource: { buffer: this.kernelInfoBuffer } },
        { binding: 4, resource: { buffer: this.paramsBuffer } },
      ],
    });

    this.configured = true;
  }

  /**
   * Perform CQT transform on configured buffers
   * configure() must be called first
   * @param inputOffset Offset into input buffer (in samples)
   * @param outputOffset Offset into output buffer (in time frames)
   * @param numFrames Number of time frames to compute
   */
  transform(
    inputOffset: number,
    outputOffset: number,
    numFrames: number
  ): void {
    if (!this.configured || !this.bindGroup || !this.paramsBuffer) {
      throw new Error("WaveletTransform not configured. Call configure() first.");
    }

    if (!this.pipeline) {
      throw new Error("WaveletTransform pipeline not initialized");
    }

    // Update parameters buffer with new offsets
    const params = new Uint32Array([
      inputOffset,
      outputOffset,
      this.numBins,
      this.maxKernelLength,
      this.hopLength,
      numFrames,
      this.configuredInputLength,
      0, // padding
    ]);

    this.device.queue.writeBuffer(this.paramsBuffer, 0, params);

    // Create command encoder and dispatch compute shader
    const commandEncoder = this.device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);

    // Dispatch: 1 thread per (frequency bin, time frame) pair
    const workgroupsX = Math.ceil(this.numBins / 64);
    const workgroupsY = numFrames;
    passEncoder.dispatchWorkgroups(workgroupsX, workgroupsY, 1);

    passEncoder.end();

    // Submit commands
    this.device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Get the number of frequency bins
   */
  getNumBins(): number {
    return this.numBins;
  }

  /**
   * Get kernel information for a specific bin
   */
  getKernel(binIndex: number): CQTKernel | undefined {
    return this.kernels[binIndex];
  }

  /**
   * Get all kernel center frequencies
   */
  getFrequencies(): number[] {
    return this.kernels.map(k => k.frequency);
  }

  /**
   * Get the calculated hop length (blockSize / batchFactor)
   */
  getHopLength(): number {
    return this.hopLength;
  }

  /**
   * Get the batch factor (number of output columns per block)
   */
  getBatchFactor(): number {
    return this.config.batchFactor;
  }

  /**
   * Get the block size
   */
  getBlockSize(): number {
    return this.config.blockSize;
  }

  /**
   * Get the output buffer (2D array: rows = time frames, columns = frequency bins)
   */
  getOutputBuffer(): GPUBuffer {
    if (!this.outputBuffer) {
      throw new Error("Output buffer not created");
    }
    return this.outputBuffer;
  }

  /**
   * Get the maximum number of time frames that can be stored
   */
  getMaxTimeFrames(): number {
    return this.maxTimeFrames;
  }

  /**
   * Reset the wavelet transform to initial state
   */
  reset(): void {
    // No state to reset - kernels are immutable
  }

  /**
   * Cleanup and destroy WebGPU resources
   */
  destroy(): void {
    this.kernelBuffer?.destroy();
    this.kernelInfoBuffer?.destroy();
    this.paramsBuffer?.destroy();
    this.outputBuffer?.destroy();
    this.configured = false;
    this.configuredInputBuffer = null;
    this.bindGroup = null;
  }
}
