import { Accumulator } from "./accumulator";
import { Transformer } from "./transformer";

/**
 * Configuration options for the Analyzer
 */
export interface AnalyzerConfig {
  /** Sample rate in Hz (e.g., 44100, 48000) */
  sampleRate: number;
  /** Number of samples per block */
  blockSize: number;
  /** Maximum number of blocks in the ring buffer */
  maxBlocks: number;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: AnalyzerConfig = {
  sampleRate: 48000,
  blockSize: 2048,
  maxBlocks: 128,
};

/**
 * Analyzer - Audio analysis engine using WebGPU
 *
 * This class provides audio analysis capabilities using WebGPU for acceleration.
 * It receives a pre-initialized WebGPU device and adapter at construction time
 * and uses them throughout its lifetime.
 *
 * The Analyzer is created and managed by the AnalyzerService singleton.
 */
export class Analyzer {
  private device: GPUDevice;
  private adapter: GPUAdapter;
  private accumulator: Accumulator;
  private transformer: Transformer;
  private config: AnalyzerConfig;

  /**
   * Create an Analyzer instance
   * @param device Pre-initialized WebGPU device
   * @param adapter Pre-initialized WebGPU adapter
   */
  constructor(device: GPUDevice, adapter: GPUAdapter) {
    this.device = device;
    this.adapter = adapter;
    this.config = { ...DEFAULT_CONFIG };
    this.accumulator = new Accumulator(this.config.blockSize, this.config.maxBlocks);
    this.transformer = new Transformer(this.device, this.accumulator);
  }

  /**
   * Get the WebGPU device
   */
  getDevice(): GPUDevice {
    return this.device;
  }

  /**
   * Get the WebGPU adapter
   */
  getAdapter(): GPUAdapter {
    return this.adapter;
  }

  /**
   * Get preferred canvas format
   */
  getPreferredCanvasFormat(): GPUTextureFormat {
    return navigator.gpu?.getPreferredCanvasFormat() || "bgra8unorm";
  }

  /**
   * Check if the device is ready for use
   */
  isReady(): boolean {
    return this.device !== null;
  }

  /**
   * Configure the analyzer
   * @param config Partial configuration object (only specified fields will be updated)
   */
  configureAnalyzer(config: Partial<AnalyzerConfig>): void {
    const configChanged =
      (config.blockSize !== undefined && config.blockSize !== this.config.blockSize) ||
      (config.maxBlocks !== undefined && config.maxBlocks !== this.config.maxBlocks);

    // Update configuration
    this.config = { ...this.config, ...config };

    // If block size or max blocks changed, recreate the accumulator and transformer
    if (configChanged) {
      // Destroy old transformer's WebGPU resources
      this.transformer.destroy();

      this.accumulator = new Accumulator(this.config.blockSize, this.config.maxBlocks);
      this.transformer = new Transformer(this.device, this.accumulator);
    }
  }

  /**
   * Process a buffer of audio samples
   * @param samples Float32Array containing audio samples
   */
  processSamples(samples: Float32Array): void {
    this.accumulator.addSamples(samples);
    this.transformer.processBlocks();
  }

  /**
   * Get the current configuration
   */
  getConfig(): AnalyzerConfig {
    return { ...this.config };
  }

  /**
   * Get the accumulator instance
   */
  getAccumulator(): Accumulator {
    return this.accumulator;
  }

  /**
   * Get the transformer instance
   */
  getTransformer(): Transformer {
    return this.transformer;
  }

  /**
   * Reset the accumulator to initial state
   */
  reset(): void {
    this.accumulator.reset();
  }

  /**
   * Cleanup and destroy all resources
   * Should be called when the analyzer is no longer needed
   */
  destroy(): void {
    this.transformer.destroy();
  }
}
