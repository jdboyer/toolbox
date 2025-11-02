/**
 * Audio test data generators for testing audio processing algorithms
 */

export interface SineWaveConfig {
  /** Frequency in Hz */
  frequency: number;
  /** Sample rate in Hz */
  sampleRate: number;
  /** Duration in seconds */
  duration: number;
  /** Amplitude (0.0 to 1.0) */
  amplitude?: number;
  /** Phase offset in radians */
  phase?: number;
}

export interface SineSweepConfig {
  /** Starting frequency in Hz */
  startFrequency: number;
  /** Ending frequency in Hz */
  endFrequency: number;
  /** Sample rate in Hz */
  sampleRate: number;
  /** Duration in seconds */
  duration: number;
  /** Amplitude (0.0 to 1.0) */
  amplitude?: number;
  /** Sweep type: 'linear' or 'logarithmic' */
  sweepType?: "linear" | "logarithmic";
}

export interface WhiteNoiseConfig {
  /** Sample rate in Hz */
  sampleRate: number;
  /** Duration in seconds */
  duration: number;
  /** Amplitude (0.0 to 1.0) */
  amplitude?: number;
  /** Random seed for reproducibility */
  seed?: number;
}

/**
 * Generate a simple sine wave
 */
export function generateSineWave(config: SineWaveConfig): Float32Array {
  const {
    frequency,
    sampleRate,
    duration,
    amplitude = 1.0,
    phase = 0,
  } = config;

  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    samples[i] = amplitude * Math.sin(2 * Math.PI * frequency * t + phase);
  }

  return samples;
}

/**
 * Generate a sine sweep (chirp) - frequency changes over time
 */
export function generateSineSweep(config: SineSweepConfig): Float32Array {
  const {
    startFrequency,
    endFrequency,
    sampleRate,
    duration,
    amplitude = 1.0,
    sweepType = "logarithmic",
  } = config;

  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const progress = t / duration;

    let frequency: number;
    let phase: number;

    if (sweepType === "linear") {
      // Linear frequency sweep
      frequency = startFrequency + (endFrequency - startFrequency) * progress;
      phase = 2 * Math.PI * (startFrequency * t + 0.5 * (endFrequency - startFrequency) * t * progress);
    } else {
      // Logarithmic frequency sweep
      const k = Math.pow(endFrequency / startFrequency, 1 / duration);
      frequency = startFrequency * Math.pow(k, t);
      phase = 2 * Math.PI * startFrequency * (Math.pow(k, t) - 1) / Math.log(k);
    }

    samples[i] = amplitude * Math.sin(phase);
  }

  return samples;
}

/**
 * Generate white noise
 */
export function generateWhiteNoise(config: WhiteNoiseConfig): Float32Array {
  const { sampleRate, duration, amplitude = 1.0, seed } = config;

  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Float32Array(numSamples);

  // Simple seeded random number generator (LCG)
  let randomSeed = seed ?? Math.floor(Math.random() * 2147483647);
  const random = () => {
    randomSeed = (randomSeed * 1103515245 + 12345) & 0x7fffffff;
    return randomSeed / 0x7fffffff;
  };

  for (let i = 0; i < numSamples; i++) {
    // Generate random value between -1 and 1
    samples[i] = amplitude * (2 * random() - 1);
  }

  return samples;
}

/**
 * Generate a mix of multiple sine waves
 */
export function generateMultiSine(
  frequencies: number[],
  sampleRate: number,
  duration: number,
  amplitude: number = 1.0
): Float32Array {
  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sum = 0;

    for (const freq of frequencies) {
      sum += Math.sin(2 * Math.PI * freq * t);
    }

    // Normalize by number of frequencies and apply amplitude
    samples[i] = amplitude * sum / frequencies.length;
  }

  return samples;
}

/**
 * Generate a DC signal (constant value)
 */
export function generateDC(
  sampleRate: number,
  duration: number,
  value: number = 1.0
): Float32Array {
  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Float32Array(numSamples);
  samples.fill(value);
  return samples;
}

/**
 * Generate an impulse (single spike)
 */
export function generateImpulse(
  sampleRate: number,
  duration: number,
  impulsePosition: number = 0,
  amplitude: number = 1.0
): Float32Array {
  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Float32Array(numSamples);

  const impulseIndex = Math.floor(impulsePosition * sampleRate);
  if (impulseIndex >= 0 && impulseIndex < numSamples) {
    samples[impulseIndex] = amplitude;
  }

  return samples;
}

/**
 * Generate silence (all zeros)
 */
export function generateSilence(sampleRate: number, duration: number): Float32Array {
  const numSamples = Math.floor(sampleRate * duration);
  return new Float32Array(numSamples);
}

/**
 * Concatenate multiple audio buffers
 */
export function concatenateAudio(...buffers: Float32Array[]): Float32Array {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
  const result = new Float32Array(totalLength);

  let offset = 0;
  for (const buffer of buffers) {
    result.set(buffer, offset);
    offset += buffer.length;
  }

  return result;
}

/**
 * Apply a fade in/out envelope to audio
 */
export function applyFade(
  samples: Float32Array,
  fadeInSamples: number,
  fadeOutSamples: number
): Float32Array {
  const result = new Float32Array(samples);

  // Fade in
  for (let i = 0; i < fadeInSamples && i < result.length; i++) {
    const gain = i / fadeInSamples;
    result[i] *= gain;
  }

  // Fade out
  const startFadeOut = result.length - fadeOutSamples;
  for (let i = 0; i < fadeOutSamples && startFadeOut + i < result.length; i++) {
    const gain = 1 - i / fadeOutSamples;
    result[startFadeOut + i] *= gain;
  }

  return result;
}
