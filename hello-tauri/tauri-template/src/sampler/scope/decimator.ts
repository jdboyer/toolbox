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
  /**
   * Batch factor - determines hop length (blockSize must be divisible by batchFactor)
   */
  batchFactor: number;
}

/**
 * Filter response data containing frequency and phase information
 */
export interface FilterResponse {
  /**
   * Array of frequencies at which the response was calculated (Hz)
   */
  frequencies: number[];
  /**
   * Magnitude response in dB at each frequency
   */
  magnitudeDB: number[];
  /**
   * Phase response in radians at each frequency
   */
  phaseRadians: number[];
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
  /**
   * Get the frequency and phase response of this band's anti-aliasing filter
   * @param numPoints Number of frequency points to calculate (default: 512)
   * @param fMin Minimum frequency in Hz (default: 1 Hz)
   * @param fMax Maximum frequency in Hz (default: effectiveSampleRate / 2)
   * @returns FilterResponse containing frequency, magnitude, and phase data
   */
  getFilterResponse: (numPoints: number, fMin?: number, fMax?: number) => FilterResponse;
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

    //console.error("Test...");
    // Create bands with exponentially spaced cutoff frequencies
    //for (let i = 0; i < this.config.numBands; i++) {
    for (let i = this.config.numBands - 1; i >= 0; i--) {
      const logCutoff = logFMin + (i + 1) * logStep;
      const cutoffFrequency = Math.pow(2, logCutoff);

      // Calculate decimation factor based on the Nyquist frequency for this band
      // Each band's Nyquist frequency is 2x the cutoff frequency
      // We want to decimate so the new sample rate is just above 2x cutoff
      const nyquistFreq = cutoffFrequency * 2;
      const bandIndex = this.config.numBands - 1 - i;
      const currentSampleRate = this.config.sampleRate / this.getCumulativeDecimationFactor(bandIndex);
      //const currentSampleRate = i === 0 ? this.config.sampleRate : this.config.sampleRate / this.getCumulativeDecimationFactor(i - 1);

      // Calculate how much we can decimate while staying above Nyquist
      const maxDecimation = Math.floor(currentSampleRate / (nyquistFreq * 1.1)); // 1.1 for safety margin
      if (maxDecimation < 2) {
        console.error("max decimation");
      }
      //const decimationFactor = Math.max(1, Math.min(maxDecimation, 4)); // Limit to 4x per stage
      let decimationFactor = Math.max(1, maxDecimation);

      // Constrain decimation factor to valid values
      // blockSize / (batchFactor * n) = decimationFactor
      // Solving for n: n = blockSize / (batchFactor * decimationFactor)
      // n must be a positive non-zero integer
      const blockSize = this.config.maxBlockSize;
      const batchFactor = this.config.batchFactor;

      // Check if current decimationFactor gives a valid integer n
      let n = blockSize / (batchFactor * decimationFactor);
      console.log(`n: ${n}, decimation: ${decimationFactor}`)
      if (!Number.isInteger(n) || n <= 0) {
        console.error("Invalid decimation factor, clamping...");
        // Find the nearest smaller valid decimation factor
        // Valid decimation factors are: blockSize / (batchFactor * n) where n is a positive integer
        // We want the largest valid decimationFactor <= current decimationFactor
        for (let testN = Math.ceil(n); testN <= (blockSize / batchFactor); testN++) {
          const validDecimationFactor = blockSize / (batchFactor * testN);
          if (Number.isInteger(validDecimationFactor) && validDecimationFactor <= decimationFactor) {
            decimationFactor = validDecimationFactor;
            n = testN;
            console.log(`after: n: ${n}, decimation: ${decimationFactor}`)
            break;
          }
        }

        // If no valid factor found, use 1 (safest fallback)
        if (!Number.isInteger(n) || n <= 0) {
          decimationFactor = 1;
        }
      }


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
   * Calculate the frequency and phase response of a filter
   * @param filterState The filter state containing biquad sections
   * @param sampleRate The sample rate at which the filter operates
   * @param numPoints Number of frequency points to calculate
   * @param fMin Minimum frequency in Hz
   * @param fMax Maximum frequency in Hz
   * @returns FilterResponse object with frequency, magnitude, and phase data
   */
  private calculateFilterResponse(
    filterState: EllipticFilterState,
    sampleRate: number,
    numPoints: number = 512,
    fMin: number = 1,
    fMax: number = sampleRate / 2
  ): FilterResponse {
    const frequencies: number[] = [];
    const magnitudeDB: number[] = [];
    const phaseRadians: number[] = [];

    // Generate logarithmically spaced frequencies
    const logFMin = Math.log10(fMin);
    const logFMax = Math.log10(fMax);
    const logStep = (logFMax - logFMin) / (numPoints - 1);
    let clamped = false;

    for (let i = 0; i < numPoints; i++) {
      const freq = Math.pow(10, logFMin + i * logStep);
      frequencies.push(freq);

      // Calculate normalized frequency (omega)
      const omega = 2 * Math.PI * freq / sampleRate;

      // Calculate complex response by cascading all biquad sections
      let realPart = 1.0;
      let imagPart = 0.0;

      for (const section of filterState.sections) {
        // Calculate frequency response of this biquad section
        // H(z) = (b0 + b1*z^-1 + b2*z^-2) / (1 + a1*z^-1 + a2*z^-2)
        // where z = e^(j*omega)

        const cos_w = Math.cos(omega);
        const sin_w = Math.sin(omega);
        const cos_2w = Math.cos(2 * omega);
        const sin_2w = Math.sin(2 * omega);

        // Numerator: b0 + b1*e^(-j*omega) + b2*e^(-j*2*omega)
        const numReal = section.b0 + section.b1 * cos_w + section.b2 * cos_2w;
        const numImag = -section.b1 * sin_w - section.b2 * sin_2w;

        // Denominator: 1 + a1*e^(-j*omega) + a2*e^(-j*2*omega)
        const denReal = 1 + section.a1 * cos_w + section.a2 * cos_2w;
        const denImag = -section.a1 * sin_w - section.a2 * sin_2w;

        // Complex division: (numReal + j*numImag) / (denReal + j*denImag)
        const denMagSq = denReal * denReal + denImag * denImag;
        const sectionReal = (numReal * denReal + numImag * denImag) / denMagSq;
        const sectionImag = (numImag * denReal - numReal * denImag) / denMagSq;

        // Multiply cascaded response by this section's response
        const newReal = realPart * sectionReal - imagPart * sectionImag;
        const newImag = realPart * sectionImag + imagPart * sectionReal;
        realPart = newReal;
        imagPart = newImag;
      }

      // Calculate magnitude in dB
      const magnitude = Math.sqrt(realPart * realPart + imagPart * imagPart);

      if (clamped === false) {
        const magDB = 20 * Math.log10(magnitude + 1e-10); // Add small value to avoid log(0)
        if (magDB > -40) {
          magnitudeDB.push(magDB);
        }
        else {
          clamped = true;
          magnitudeDB.push(-40);
        }
        //magnitudeDB.push(20 * Math.log10(magnitude + 1e-10)); // Add small value to avoid log(0)
        //if (magnitudeDB.)
      }
      else if (clamped === true) {
          magnitudeDB.push(-40);
      }

      // Calculate phase in radians
      const phase = Math.atan2(imagPart, realPart);
      phaseRadians.push(phase);
    }

    return {
      frequencies,
      magnitudeDB,
      phaseRadians,
    };
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
      getFilterResponse: (numPoints?: number, fMin?: number, fMax?: number) => {
        const effectiveSampleRate = this.config.sampleRate / this.getCumulativeDecimationFactor(index - 1);
        return this.calculateFilterResponse(
          band.filterState,
          effectiveSampleRate,
          numPoints,
          fMin ?? 1,
          fMax ?? effectiveSampleRate / 2
        );
      },
    }));
  }


}
