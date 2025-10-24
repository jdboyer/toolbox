# WebGPU Constant-Q Transform (CQT)

A high-performance, GPU-accelerated implementation of the Constant-Q Transform for audio analysis using WebGPU and TypeScript.

## Features

- **Pure WebGPU compute shaders** for maximum performance
- **Logarithmic frequency bins** ideal for musical analysis
- **Fully configurable** parameters (frequency range, bins per octave, hop length, etc.)
- **Multiple output formats** (raw Float32Array, PNG visualization, custom binary format)
- **Works with Deno** for easy testing and development

## Installation

This is a standalone TypeScript module. Simply import it into your Deno project:

```typescript
import { computeCQT, type CQTConfig } from "./cqt.ts";
```

## Requirements

- **Deno** with WebGPU support
- GPU with WebGPU capabilities (most modern GPUs)

## Usage

### Basic Example

```typescript
import { computeCQT, magnitudesToDB } from "./cqt.ts";

// Your mono audio data (Float32Array)
const audioData = new Float32Array([...]);

// Configure the transform
const config = {
  sampleRate: 44100,        // Audio sample rate in Hz
  fmin: 32.7,               // Minimum frequency (C1)
  fmax: 8000,               // Maximum frequency (or omit for sampleRate/2)
  binsPerOctave: 12,        // 12 bins = semitone resolution
  hopLength: 512,           // Samples between frames
};

// Compute CQT
const result = await computeCQT(audioData, config);

console.log(`Computed CQT with ${result.numBins} bins and ${result.numFrames} frames`);
console.log(`Frequency range: ${result.frequencies[0]} Hz to ${result.frequencies[result.numBins-1]} Hz`);
console.log(`Time range: ${result.timeStart}s to ${result.timeEnd}s`);

// Access magnitude data (2D matrix in column-major order)
// result.magnitudes[frame * result.numBins + bin]
```

### Configuration Options

```typescript
interface CQTConfig {
  sampleRate: number;        // Required: Audio sample rate
  fmin: number;              // Required: Minimum frequency in Hz
  fmax?: number;             // Optional: Maximum frequency (default: sampleRate/2)
  binsPerOctave: number;     // Required: Frequency resolution
  hopLength: number;         // Required: Time resolution in samples
  windowScale?: number;      // Optional: Window length scaling (default: 1.0)
  threshold?: number;        // Optional: Kernel sparsity threshold (default: 0.0054)
}
```

### Result Structure

```typescript
interface CQTResult {
  magnitudes: Float32Array;  // 2D magnitude matrix [frame * numBins + bin]
  numBins: number;           // Number of frequency bins
  numFrames: number;         // Number of time frames
  frequencies: Float32Array; // Frequency of each bin in Hz
  timeStart: number;         // Time of first frame (seconds)
  timeEnd: number;           // Time of last frame (seconds)
  timeStep: number;          // Time between frames (seconds)
}
```

### Converting to dB Scale

```typescript
import { magnitudesToDB } from "./cqt.ts";

const magnitudesDB = magnitudesToDB(
  result.magnitudes,
  1.0,    // Reference value
  -80     // Minimum dB value
);
```

## Running Tests

The test suite demonstrates the CQT with synthetic signals and optionally a custom WAV file:

```bash
# Run all tests
deno task test

# Or manually
deno test --allow-read --allow-write --unstable-webgpu test/cqt_test.ts
```

### Test Files Generated

After running tests, you'll find these files in the `test/` directory:

- `output_sine_wave.png` - Visualization of 440 Hz sine wave CQT
- `output_sine_wave.cqt` - Raw binary CQT data
- `output_chirp.png` - Visualization of frequency sweep
- `output_custom.png` - CQT of custom WAV file (if provided)

### Using Custom Audio Files

To test with your own audio:

1. Place a WAV file at `test/test_audio.wav`
2. Run the tests
3. The CQT will be saved to `test/output_custom.png` and `test/output_custom.cqt`

## Performance Considerations

- **GPU acceleration** makes this implementation very fast for large audio files
- **Hop length** affects time resolution and computation time (smaller = more frames)
- **Bins per octave** affects frequency resolution (more bins = more computation)
- WebGPU buffers are automatically cleaned up after computation

## Output Formats

### 1. Float32Array (Default)

Direct access to magnitude values in column-major order:

```typescript
const magnitude = result.magnitudes[frame * result.numBins + bin];
```

### 2. PNG Images (Test Utility)

Grayscale PNG with time on X-axis, frequency on Y-axis:

```typescript
import { savePNG } from "./test/png_writer.ts";
await savePNG(data, width, height, "output.png");
```

### 3. Raw Binary (Test Utility)

Custom binary format with metadata header:

```typescript
import { saveRawBinary, readRawBinary } from "./test/png_writer.ts";
await saveRawBinary(result.magnitudes, result.numFrames, result.numBins, "output.cqt");
const loaded = await readRawBinary("output.cqt");
```

## Technical Details

### Algorithm

The CQT is computed using:

1. **Kernel Generation**: Hamming-windowed complex exponentials for each frequency bin
2. **GPU Convolution**: Each workgroup computes one (bin, frame) pair via convolution
3. **Magnitude Calculation**: `sqrt(real² + imag²)` computed in shader

### Frequency Bins

Bins are logarithmically spaced:

```
f[k] = fmin * 2^(k / binsPerOctave)
```

- `binsPerOctave = 12` → semitone resolution (standard musical scale)
- `binsPerOctave = 24` → quarter-tone resolution
- `binsPerOctave = 36` → 1/3 semitone resolution (very high quality)

### Time Frames

Frame timing:

```
time[frame] = frame * hopLength / sampleRate
```

## Advanced Usage

### High-Resolution Analysis

```typescript
const config = {
  sampleRate: 44100,
  fmin: 20,              // Lower bound (near human hearing limit)
  fmax: 20000,           // Upper bound (human hearing limit)
  binsPerOctave: 36,     // Very high frequency resolution
  hopLength: 128,        // High time resolution
};
```

### Musical Note Detection

```typescript
const config = {
  sampleRate: 44100,
  fmin: 32.7,           // C1
  fmax: 4186,           // C8 (piano range)
  binsPerOctave: 12,    // One bin per semitone
  hopLength: 512,
};
```

### Speech Analysis

```typescript
const config = {
  sampleRate: 16000,
  fmin: 80,             // Typical voice fundamental
  fmax: 8000,
  binsPerOctave: 24,
  hopLength: 160,       // 10ms frames
};
```

## Limitations

- Input must be mono audio (use `stereoToMono` helper in tests for multi-channel)
- Requires WebGPU support (not available in all browsers/environments)
- Memory usage grows with: `numBins * numFrames * 4 bytes`
- **Very low frequencies create large kernels**: At high sample rates (e.g., 48kHz), using very low `fmin` values (e.g., 32.7 Hz) creates extremely large GPU buffers. Recommended minimum frequencies:
  - 44.1kHz sample rate: `fmin >= 55 Hz` (A1)
  - 48kHz sample rate: `fmin >= 65 Hz` (C2)
  - For lower frequencies, consider downsampling your audio first

## License

This is part of a personal toolbox repository. Use freely for your projects.

## References

- Brown, J.C. (1991). "Calculation of a constant Q spectral transform"
- Schörkhuber, C. & Klapuri, A. (2010). "Constant-Q transform toolbox for music processing"
