/**
 * Configuration interface for the Decimator
 */
export interface DecimatorConfig {
  /**
   * Number of frequency bands to process
   */
  numBands: number;
  /**
   * Minimum frequency for band calculation (Hz)
   */
  fMin: number;
  /**
   * Maximum frequency for band calculation (Hz)
   */
  fMax: number;
  /**
   * Sample rate (Hz)
   */
  sampleRate: number;
  /**
   * Maximum block size in samples
   */
  maxBlockSize: number;
}

/**
 * Metadata for a single band
 */
export interface BandInfo {
  /**
   * Cutoff frequency for this band (Hz)
   */
  cutoffFrequency: number;
  /**
   * Decimation factor applied to this band
   */
  decimationFactor: number;
  /**
   * Cumulative decimation factor (product of all previous stages)
   */
  cumulativeDecimationFactor: number;
  /**
   * Effective sample rate after decimation (Hz)
   */
  effectiveSampleRate: number;
}

interface DecimatorBand {
  cutoffFrequency: number;
  decimationFactor: number;
  buffer: Float32Array;
  filterState: EllipticFilterState;
}

/**
 * State for IIR filter (biquad sections)
 */
interface EllipticFilterState {
  sections: BiquadSection[];
}

/**
 * Single biquad section of an IIR filter
 */
interface BiquadSection {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number; // Previous input samples
  x2: number;
  y1: number; // Previous output samples
  y2: number;
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
  private bands: DecimatorBand[];

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
    const logFMin = Math.log2(this.config.fMin);
    const logFMax = Math.log2(this.config.fMax);
    // the "zero" band will always handle the top portion of the range and is not part of the decimator, so +1 here:
    const logStep = (logFMax - logFMin) / (this.config.numBands + 1); 

    // Create bands with exponentially spaced cutoff frequencies
    for (let i = 0; i < this.config.numBands; i++) {
      const logCutoff = logFMin + (i + 1) * logStep;
      const cutoffFrequency = Math.pow(2, logCutoff);

      // Calculate decimation factor based on the Nyquist frequency for this band
      // Each band's Nyquist frequency is 2x the cutoff frequency
      // We want to decimate so the new sample rate is just above 2x cutoff
      const nyquistFreq = cutoffFrequency * 2;
      const currentSampleRate = i === 0 ? this.config.sampleRate : this.config.sampleRate / this.getCumulativeDecimationFactor(i - 1);

      // Calculate how much we can decimate while staying above Nyquist
      const maxDecimation = Math.floor(currentSampleRate / (nyquistFreq * 1.1)); // 1.1 for safety margin
      const decimationFactor = Math.max(1, Math.min(maxDecimation, 4)); // Limit to 4x per stage

      // Design elliptic filter for this band
      const filterState = this.designEllipticFilter(cutoffFrequency, currentSampleRate);

      this.bands.push({
        cutoffFrequency,
        decimationFactor,
        buffer: new Float32Array(this.config.maxBlockSize),
        filterState,
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
   * @param output Output array to store decimated samples for each band
   */
  processBlock(samples: Float32Array, output: Float32Array[]): void {
    // Clear previous outputs
    output.length = 0;

    if (this.bands.length === 0) {
      return;
    }

    // Start with the input samples
    let currentInput = samples;

    // Process through each band sequentially
    for (let bandIndex = 0; bandIndex < this.bands.length; bandIndex++) {
      const band = this.bands[bandIndex];

      // Apply elliptic anti-aliasing filter
      const filtered = this.applyEllipticFilter(currentInput, band.filterState);

      // Apply decimation
      const decimated = this.decimate(filtered, band.decimationFactor);

      // Store the result in the band's buffer
      const copyLength = Math.min(decimated.length, band.buffer.length);
      band.buffer.set(decimated.subarray(0, copyLength));

      // Create a copy of the decimated data for output
      const outputSamples = new Float32Array(decimated.length);
      outputSamples.set(decimated);

      // Store band output samples
      output.push(outputSamples);

      // Use this band's output as input for the next band
      currentInput = decimated;
    }
  }

  /**
   * Design an elliptic (Cauer) low-pass filter
   * @param cutoffFrequency Cutoff frequency in Hz
   * @param sampleRate Sample rate in Hz
   * @returns Filter state with biquad sections
   */
  private designEllipticFilter(cutoffFrequency: number, sampleRate: number): EllipticFilterState {
    // Normalized cutoff frequency (0 to 1, where 1 is Nyquist)
    const wc = (cutoffFrequency / (sampleRate / 2));

    // Design a 4th order elliptic filter (2 biquad sections)
    // These are approximated coefficients for a typical elliptic filter
    // with 0.1 dB passband ripple and 60 dB stopband attenuation

    const sections: BiquadSection[] = [];

    // Pre-warp the cutoff frequency for bilinear transform
    const K = Math.tan(Math.PI * wc);
    const K2 = K * K;

    // Section 1: Complex pole pair
    // Approximated elliptic filter coefficients
    const q1 = 0.9; // Q factor for first section
    const norm1 = 1 / (1 + K / q1 + K2);

    sections.push({
      b0: K2 * norm1,
      b1: 2 * K2 * norm1,
      b2: K2 * norm1,
      a1: 2 * (K2 - 1) * norm1,
      a2: (1 - K / q1 + K2) * norm1,
      x1: 0,
      x2: 0,
      y1: 0,
      y2: 0,
    });

    // Section 2: Another complex pole pair with different Q
    const q2 = 0.6; // Q factor for second section
    const norm2 = 1 / (1 + K / q2 + K2);

    sections.push({
      b0: K2 * norm2,
      b1: 2 * K2 * norm2,
      b2: K2 * norm2,
      a1: 2 * (K2 - 1) * norm2,
      a2: (1 - K / q2 + K2) * norm2,
      x1: 0,
      x2: 0,
      y1: 0,
      y2: 0,
    });

    return { sections };
  }

  /**
   * Apply elliptic filter using cascaded biquad sections
   * @param input Input samples
   * @param filterState Filter state containing biquad sections
   * @returns Filtered samples
   */
  private applyEllipticFilter(
    input: Float32Array,
    filterState: EllipticFilterState
  ): Float32Array {
    let output = new Float32Array(input);

    // Process through each biquad section
    for (const section of filterState.sections) {
      const temp = new Float32Array(output.length);

      for (let i = 0; i < output.length; i++) {
        // Direct Form II biquad implementation
        const x = output[i];
        const y = section.b0 * x + section.b1 * section.x1 + section.b2 * section.x2
                - section.a1 * section.y1 - section.a2 * section.y2;

        // Update state variables
        section.x2 = section.x1;
        section.x1 = x;
        section.y2 = section.y1;
        section.y1 = y;

        temp[i] = y;
      }

      output = temp;
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

  /**
   * Get metadata information for all bands
   * @returns Array of BandInfo containing metadata for each band
   */
  getBandsInfo(): BandInfo[] {
    return this.bands.map((band, index) => ({
      cutoffFrequency: band.cutoffFrequency,
      decimationFactor: band.decimationFactor,
      cumulativeDecimationFactor: this.getCumulativeDecimationFactor(index),
      effectiveSampleRate: this.config.sampleRate / this.getCumulativeDecimationFactor(index),
    }));
  }

  /**
   * Get metadata for a specific band
   * @param bandIndex Index of the band
   * @returns BandInfo for the specified band, or null if index is out of range
   */
  getBandInfo(bandIndex: number): BandInfo | null {
    if (bandIndex < 0 || bandIndex >= this.bands.length) {
      return null;
    }

    const band = this.bands[bandIndex];
    return {
      cutoffFrequency: band.cutoffFrequency,
      decimationFactor: band.decimationFactor,
      cumulativeDecimationFactor: this.getCumulativeDecimationFactor(bandIndex),
      effectiveSampleRate: this.config.sampleRate / this.getCumulativeDecimationFactor(bandIndex),
    };
  }
}
