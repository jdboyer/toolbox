/**
 * Configuration interface for the Decimator
 */
export interface DecimatorConfig {
  /**
   * Number of frequency bands to process
   */
  numBands: number;
}

interface DecimatorBand {
  cutoffFrequency: number;
  decimationFactor: number;
  buffer: Float32Array;
}

/**
 * Decimator - Processes audio sample blocks for multi-band analysis
 *
 * This class is responsible for:
 * 1. Processing blocks of audio samples
 * 2. Managing multi-band decimation configuration
 */
export class Decimator {
  private config: DecimatorConfig;
  private fMin: number = 60.0;
  private fMax: number = 20000.0;
  private sampleRate: number = 48000.0;
  private bands: DecimatorBand[];
  private maxBlockSize: number = 4096;

  /**
   * Create a Decimator instance
   * @param config Initial configuration for the decimator
   */
  constructor(config: DecimatorConfig) {
    this.config = config;
    this.bands = [];
    this.updateBands();
  }

  /**
   * Configure the decimator with new settings
   * @param config New configuration to apply
   */
  configure(config: DecimatorConfig): void {
    this.config = config;
    this.updateBands();
  }

  /**
   * Update band configuration based on numBands
   * Calculates cutoff frequencies and decimation factors for each band
   */
  updateBands(): void {
    this.bands = [];

    if (this.config.numBands === 0) {
      return;
    }

    // Calculate frequency range on logarithmic scale
    const logFMin = Math.log2(this.fMin);
    const logFMax = Math.log2(this.fMax);
    const logStep = (logFMax - logFMin) / this.config.numBands;

    // Create bands with exponentially spaced cutoff frequencies
    for (let i = 0; i < this.config.numBands; i++) {
      const logCutoff = logFMin + (i + 1) * logStep;
      const cutoffFrequency = Math.pow(2, logCutoff);

      // Calculate decimation factor based on the Nyquist frequency for this band
      // Each band's Nyquist frequency is 2x the cutoff frequency
      // We want to decimate so the new sample rate is just above 2x cutoff
      const nyquistFreq = cutoffFrequency * 2;
      const currentSampleRate = i === 0 ? this.sampleRate : this.sampleRate / this.getCumulativeDecimationFactor(i - 1);

      // Calculate how much we can decimate while staying above Nyquist
      const maxDecimation = Math.floor(currentSampleRate / (nyquistFreq * 1.1)); // 1.1 for safety margin
      const decimationFactor = Math.max(1, Math.min(maxDecimation, 4)); // Limit to 4x per stage

      this.bands.push({
        cutoffFrequency,
        decimationFactor,
        buffer: new Float32Array(this.maxBlockSize),
      });
    }
  }

  /**
   * Get the cumulative decimation factor up to and including band index
   * @param bandIndex Band index
   * @returns Cumulative decimation factor
   */
  private getCumulativeDecimationFactor(bandIndex: number): number {
    let cumulative = 1;
    for (let i = 0; i <= bandIndex && i < this.bands.length; i++) {
      cumulative *= this.bands[i].decimationFactor;
    }
    return cumulative;
  }

  /**
   * Process a block of audio samples
   * Applies cascaded anti-aliasing filtering and decimation through each band
   * @param samples Float32Array containing audio samples to process
   */
  processBlock(samples: Float32Array): void {
    if (this.bands.length === 0) {
      return;
    }

    // Start with the input samples
    let currentInput = samples;

    // Process through each band sequentially
    for (let bandIndex = 0; bandIndex < this.bands.length; bandIndex++) {
      const band = this.bands[bandIndex];
      const currentSampleRate = bandIndex === 0
        ? this.sampleRate
        : this.sampleRate / this.getCumulativeDecimationFactor(bandIndex - 1);

      // Apply anti-aliasing low-pass filter
      const filtered = this.applyAntiAliasingFilter(
        currentInput,
        band.cutoffFrequency,
        currentSampleRate
      );

      // Apply decimation
      const decimated = this.decimate(filtered, band.decimationFactor);

      // Store the result in the band's buffer
      const copyLength = Math.min(decimated.length, band.buffer.length);
      band.buffer.set(decimated.subarray(0, copyLength));

      // Use this band's output as input for the next band
      currentInput = decimated;
    }
  }

  /**
   * Apply a simple low-pass anti-aliasing filter
   * Uses a simple moving average filter as a basic anti-aliasing filter
   * @param input Input samples
   * @param cutoffFrequency Cutoff frequency in Hz
   * @param sampleRate Current sample rate in Hz
   * @returns Filtered samples
   */
  private applyAntiAliasingFilter(
    input: Float32Array,
    cutoffFrequency: number,
    sampleRate: number
  ): Float32Array {
    // Calculate filter kernel size based on cutoff frequency
    // Simple approximation: kernel size inversely proportional to cutoff ratio
    const cutoffRatio = cutoffFrequency / (sampleRate / 2);
    const kernelSize = Math.max(3, Math.min(31, Math.floor(1 / cutoffRatio)));

    // Ensure kernel size is odd
    const actualKernelSize = kernelSize % 2 === 0 ? kernelSize + 1 : kernelSize;
    const halfKernel = Math.floor(actualKernelSize / 2);

    const output = new Float32Array(input.length);

    // Apply simple moving average filter
    for (let i = 0; i < input.length; i++) {
      let sum = 0;
      let count = 0;

      for (let k = -halfKernel; k <= halfKernel; k++) {
        const sampleIndex = i + k;
        if (sampleIndex >= 0 && sampleIndex < input.length) {
          sum += input[sampleIndex];
          count++;
        }
      }

      output[i] = sum / count;
    }

    return output;
  }

  /**
   * Decimate samples by a given factor
   * @param input Input samples
   * @param factor Decimation factor (e.g., 2 means keep every 2nd sample)
   * @returns Decimated samples
   */
  private decimate(input: Float32Array, factor: number): Float32Array {
    if (factor === 1) {
      return input;
    }

    const outputLength = Math.ceil(input.length / factor);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      output[i] = input[i * factor];
    }

    return output;
  }

  /**
   * Get the current configuration
   * @returns Current DecimatorConfig
   */
  getConfig(): DecimatorConfig {
    return { ...this.config };
  }

  /**
   * Get the number of bands
   * @returns Number of frequency bands
   */
  getNumBands(): number {
    return this.config.numBands;
  }
}
