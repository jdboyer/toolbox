# Quick Start Guide

## Running the Examples

```bash
# Run the examples
deno run --allow-read --unstable-webgpu example.ts

# Run the tests
deno task test
```

## Basic Usage

```typescript
import { computeCQT } from "./cqt.ts";

// Your mono audio data
const audioData = new Float32Array([/* your samples */]);

// Configure the transform
const result = await computeCQT(audioData, {
  sampleRate: 44100,
  fmin: 32.7,
  binsPerOctave: 12,
  hopLength: 512,
});

// Access the results
console.log(`Frequency bins: ${result.numBins}`);
console.log(`Time frames: ${result.numFrames}`);

// Access magnitude at specific (frame, bin)
const magnitude = result.magnitudes[frame * result.numBins + bin];
```

## Key Points

1. **Input**: Mono audio as `Float32Array` (values typically in [-1, 1])
2. **Output**: 2D magnitude matrix in column-major order
3. **Indexing**: `magnitudes[frame * numBins + bin]`
4. **Frequencies**: Logarithmically spaced from `fmin` to `fmax`
5. **Time**: Frames are spaced by `hopLength` samples

## Common Configurations

### Musical Analysis (Semitone Resolution)
```typescript
{
  sampleRate: 44100,
  fmin: 32.7,      // C1
  binsPerOctave: 12,
  hopLength: 512,
}
```

### High-Frequency Resolution
```typescript
{
  sampleRate: 44100,
  fmin: 32.7,
  binsPerOctave: 36,  // 3 bins per semitone
  hopLength: 256,
}
```

### Speech Analysis
```typescript
{
  sampleRate: 16000,
  fmin: 80,
  fmax: 8000,
  binsPerOctave: 24,
  hopLength: 160,  // 10ms frames
}
```

## Files

- [cqt.ts](cqt.ts) - Main CQT implementation
- [example.ts](example.ts) - Usage examples
- [test/cqt_test.ts](test/cqt_test.ts) - Test suite
- [test/wav_reader.ts](test/wav_reader.ts) - WAV file utilities
- [test/png_writer.ts](test/png_writer.ts) - Output format utilities
- [README.md](README.md) - Full documentation
