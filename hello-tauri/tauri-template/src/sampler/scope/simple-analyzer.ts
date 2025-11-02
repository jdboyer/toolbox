import { ScopeRenderer } from "./scope-renderer.ts";

/**
 * DEAD SIMPLE SPECTROGRAM ANALYZER
 *
 * Audio samples → sliding window CQT → write columns to texture
 * That's it. No complex buffers, no pipeline, just works.
 */

interface CQTConfig {
  sampleRate: number;
  fmin: number;
  fmax: number;
  binsPerOctave: number;
  hopLength: number;
}

const DEFAULT_CONFIG: CQTConfig = {
  sampleRate: 48000,
  fmin: 20,
  fmax: 20000,
  binsPerOctave: 12,
  hopLength: 512,
};

export class SimpleAnalyzer {
  private device: GPUDevice;
  private renderer: ScopeRenderer | null = null;
  private config: CQTConfig;

  // Audio buffer for sliding window
  private audioBuffer: Float32Array = new Float32Array(0);

  // CQT kernels
  private kernels: Float32Array | null = null;
  private kernelLengths: Uint32Array | null = null;
  private numBins = 0;
  private maxKernelLength = 0;

  // Current column index in texture
  private currentColumn = 0;

  constructor(device: GPUDevice) {
    this.device = device;
    this.config = { ...DEFAULT_CONFIG };
    this.generateCQTKernels();
  }

  /**
   * Initialize with a canvas for rendering
   */
  async initialize(canvas: HTMLCanvasElement): Promise<boolean> {
    console.log("SimpleAnalyzer: Initializing renderer");
    this.renderer = new ScopeRenderer(this.device, this as any);
    const result = await this.renderer.initialize(canvas);
    console.log("SimpleAnalyzer: Renderer initialized:", result);

    // Write test pattern to verify rendering works
    console.log("SimpleAnalyzer: Writing test pattern");
    this.writeTestPattern();

    return result;
  }

  /**
   * Write a test pattern to the texture
   */
  private writeTestPattern() {
    if (!this.renderer) return;

    const textureHeight = this.renderer.getTextureHeight();
    const textureWidth = this.renderer.getTextureWidth();

    console.log(`Writing test pattern: ${textureWidth}x${textureHeight}`);

    // Write a gradient pattern
    for (let col = 0; col < Math.min(100, textureWidth); col++) {
      const testData = new Float32Array(textureHeight);
      for (let i = 0; i < textureHeight; i++) {
        // Create a gradient from 0 to 1
        testData[i] = (i / textureHeight) * 0.5 + (col / 100) * 0.5;
      }
      this.renderer.writeColumn(col, testData);
    }

    console.log("Test pattern written");
  }

  /**
   * Generate CQT basis functions (kernels)
   */
  private generateCQTKernels() {
    const { sampleRate, fmin, fmax, binsPerOctave } = this.config;

    // Calculate number of bins
    this.numBins = Math.ceil(binsPerOctave * Math.log2(fmax / fmin));

    // Calculate Q factor
    const Q = 1.0 / (Math.pow(2, 1.0 / binsPerOctave) - 1);

    // Calculate kernel lengths for each frequency bin
    this.kernelLengths = new Uint32Array(this.numBins);
    this.maxKernelLength = 0;

    const frequencies = new Float32Array(this.numBins);
    for (let k = 0; k < this.numBins; k++) {
      frequencies[k] = fmin * Math.pow(2, k / binsPerOctave);
      const length = Math.ceil((Q * sampleRate) / frequencies[k]);
      this.kernelLengths[k] = length;
      this.maxKernelLength = Math.max(this.maxKernelLength, length);
    }

    // Generate complex kernels (real, imag pairs)
    this.kernels = new Float32Array(this.numBins * this.maxKernelLength * 2);

    for (let k = 0; k < this.numBins; k++) {
      const freq = frequencies[k];
      const length = this.kernelLengths[k];
      const offset = k * this.maxKernelLength * 2;

      for (let n = 0; n < length; n++) {
        // Hamming window
        const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (length - 1));

        // Complex exponential: e^(-2πi * freq * n / sampleRate)
        const phase = -2 * Math.PI * freq * n / sampleRate;
        const real = window * Math.cos(phase);
        const imag = window * Math.sin(phase);

        this.kernels[offset + n * 2] = real;
        this.kernels[offset + n * 2 + 1] = imag;
      }

      // Normalize
      let energy = 0;
      for (let n = 0; n < length; n++) {
        const real = this.kernels[offset + n * 2];
        const imag = this.kernels[offset + n * 2 + 1];
        energy += real * real + imag * imag;
      }
      const norm = Math.sqrt(energy);
      if (norm > 0) {
        for (let n = 0; n < length; n++) {
          this.kernels[offset + n * 2] /= norm;
          this.kernels[offset + n * 2 + 1] /= norm;
        }
      }
    }
  }

  /**
   * Compute CQT for a single window of audio
   */
  private computeCQT(windowStart: number): Float32Array {
    const result = new Float32Array(this.numBins);

    if (!this.kernels || !this.kernelLengths) return result;

    for (let k = 0; k < this.numBins; k++) {
      const kernelLength = this.kernelLengths[k];
      const offset = k * this.maxKernelLength * 2;

      let real = 0;
      let imag = 0;

      // Convolve with kernel
      for (let n = 0; n < kernelLength; n++) {
        const sampleIdx = windowStart + n;
        if (sampleIdx >= this.audioBuffer.length) break;

        const sample = this.audioBuffer[sampleIdx];
        const kernelReal = this.kernels[offset + n * 2];
        const kernelImag = this.kernels[offset + n * 2 + 1];

        real += sample * kernelReal;
        imag += sample * kernelImag;
      }

      // Magnitude
      result[k] = Math.sqrt(real * real + imag * imag);
    }

    return result;
  }

  /**
   * Process incoming audio samples
   */
  processSamples(samples: Float32Array) {
    if (!this.renderer) return;

    // Append to buffer
    const newBuffer = new Float32Array(this.audioBuffer.length + samples.length);
    newBuffer.set(this.audioBuffer);
    newBuffer.set(samples, this.audioBuffer.length);
    this.audioBuffer = newBuffer;

    // Process all possible hops
    const { hopLength } = this.config;
    const textureWidth = this.renderer.getTextureWidth();
    const textureHeight = this.renderer.getTextureHeight();

    while (this.audioBuffer.length >= this.maxKernelLength) {
      // Compute CQT for this window
      const cqtResult = this.computeCQT(0);

      // Resize to match texture height if needed
      const resized = new Float32Array(textureHeight);
      for (let i = 0; i < textureHeight; i++) {
        const srcIdx = Math.floor(i * this.numBins / textureHeight);
        resized[i] = cqtResult[srcIdx];
      }

      // Write column to texture
      this.renderer.writeColumn(this.currentColumn, resized);

      // Advance column (wrap around)
      this.currentColumn = (this.currentColumn + 1) % textureWidth;

      // Slide window forward by hop length
      this.audioBuffer = this.audioBuffer.slice(hopLength);
    }
  }

  /**
   * Start rendering
   */
  startRendering() {
    this.renderer?.startRendering();
  }

  /**
   * Stop rendering
   */
  stopRendering() {
    this.renderer?.stopRendering();
  }

  /**
   * Reset state
   */
  reset() {
    this.audioBuffer = new Float32Array(0);
    this.currentColumn = 0;
  }

  /**
   * Cleanup
   */
  destroy() {
    this.renderer?.destroy();
    this.renderer = null;
  }

  getDevice(): GPUDevice {
    return this.device;
  }

  getScopeRenderer(): ScopeRenderer | null {
    return this.renderer;
  }
}
