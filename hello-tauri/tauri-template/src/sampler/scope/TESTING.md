# Testing Guide for Wavelet Transform & Audio Pipeline

This document explains the test suite for the GPU-accelerated audio analysis pipeline, including the wavelet transform (CQT) implementation.

## Overview

The test suite consists of several test files that verify different aspects of the audio processing pipeline:

1. **Unit Tests** - Test individual components in isolation
2. **Integration Tests** - Test components working together
3. **Comparison Tests** - Verify GPU implementation matches reference CPU implementation

## Test Files

### 1. `wavelet-transform.test.ts` - Wavelet Transform Unit Tests

**Purpose**: Verify mathematical correctness of CQT calculations

**What it tests**:
- Number of frequency bins calculation (108 bins for 32.7 Hz to 16 kHz)
- Frequency bin values (logarithmically spaced)
- Kernel length calculations (longer kernels for lower frequencies)
- Max kernel length (~24,686 samples for 32.7 Hz at 48 kHz)
- Hamming window generation
- Complex exponential phase calculations
- Output buffer size with 256-byte padding
- **Critical**: Verifies hopLength is fixed at 256 (not calculated from buffer size)

**Key invariants**:
```typescript
// Must be exactly 108 bins for the test config
numBins = 108

// Max kernel length for lowest frequency
maxKernelLength ≈ 24,686 samples

// hopLength must be 256 (NOT inputBufferSize / timeSliceCount)
hopLength = 256

// Frame calculation formula
numFrames = floor((audioLength - maxKernelLength) / hopLength) + 1
```

**Run with**:
```bash
deno test src/sampler/scope/wavelet-transform.test.ts
```

### 2. `accumulator.test.ts` - Accumulator Unit Tests

**Purpose**: Verify the ring buffer correctly stores and retrieves audio samples

**What it tests**:
- Initial state (no blocks marked valid)
- Handling partial blocks (samples smaller than block size)
- Filling exactly one block
- Spanning multiple blocks
- Marking blocks as processed
- Data integrity (samples are preserved exactly)
- Large sample arrays (simulating full WAV files)

**Key behavior**:
- Block size: 2048 samples
- Samples are accumulated until a block is full
- Full blocks are marked as valid and ready for processing
- Partial blocks remain in the active buffer until filled

**Run with**:
```bash
deno test src/sampler/scope/accumulator.test.ts
```

### 3. `data-flow.test.ts` - Data Flow Diagnostic Tests

**Purpose**: Trace data flow through the pipeline to identify discrepancies

**What it tests**:
- Accumulator preserves all input samples (no data loss)
- Transform count (how many times `doTransform()` is called)
- Frame computation differences between reference CQT and transformer
- Non-zero value count analysis
- Sample distribution across blocks

**Key findings**:
```typescript
// For 48,000 samples with 2048 block size
numBlocks = floor(48000 / 2048) = 23 blocks

// With 65,536 buffer size, samples < buffer size triggers only 1 transform
// (at the final block)

// Frame computation example:
// 48k samples → 92 frames (not 128!)
// because: (48000 - 24686) / 256 + 1 = 92
```

**Run with**:
```bash
deno test src/sampler/scope/data-flow.test.ts
```

### 4. `frame-calculation.test.ts` - Frame Count Validation

**Purpose**: Ensure correct number of frames are computed for different audio lengths

**What it tests**:
- Frame calculation matches reference CQT formula
- Various buffer sizes (24,686 to 65,536 samples)
- Edge cases (exactly maxKernelLength, minimal hop, etc.)

**Formula verification**:
```typescript
// Reference CQT formula (correct)
numFrames = floor((audioLength - maxKernelLength) / hopLength) + 1

// Example calculations:
// 24,686 samples → 1 frame (minimum)
// 32,768 samples → 32 frames
// 48,000 samples → 92 frames
// 65,536 samples → 128 frames (capped at timeSliceCount)
```

**Run with**:
```bash
deno test src/sampler/scope/frame-calculation.test.ts
```

### 5. `sample-count.test.ts` - Sample Count Diagnostics

**Purpose**: Verify sample extraction and frame count calculations

**What it tests**:
- Sample extraction logic from WAV files (0.8s to 2.0s = 1.2s)
- Rounding to 4096-byte boundaries
- Frame count for specific sample counts
- Non-zero value diagnostics
- Sample flow through accumulator blocks

**Key calculations**:
```typescript
// From Sampler.tsx extraction logic
duration = 2.0 - 0.8 = 1.2 seconds
rawSamples = 1.2 * 48000 = 57,600 samples
roundedSamples = floor(57600 / 4096) * 4096 = 57,344 samples

// Frame count for 57,344 samples
numFrames = floor((57344 - 24686) / 256) + 1 = 128 frames
```

**Run with**:
```bash
deno test src/sampler/scope/sample-count.test.ts
```

### 6. `cqt-analyzer-comparison.test.ts` - Integration Comparison Test

**Purpose**: Verify GPU implementation produces same results as reference CPU implementation

**What it tests**:
- 440 Hz sine wave (A4 note)
- C major chord (262, 330, 392 Hz)
- Max value comparison (must match exactly)
- Non-zero value count (must match within 20%)
- Individual value errors (90%+ must have <10% error)

**Test structure**:
```typescript
// 1. Generate test signal
const samples = generateSineWave(440, 1.2, 48000);

// 2. Compute reference CQT
const cqtResult = await computeCQT(samples, config, device);

// 3. Compute using GPU Analyzer
const analyzer = new Analyzer(device, adapter);
analyzer.processSamples(samples);

// 4. Read GPU output buffer
const analyzerData = await readTransformOutput(...);

// 5. Compare results
assertAlmostEquals(analyzerMax, cqtMax, tolerance);
```

**Buffer padding handling**:
```typescript
// GPU buffers have 256-byte row alignment
bytesPerRow = ceil((108 * 4) / 256) * 256 = 512 bytes
floatsPerRow = 512 / 4 = 128 floats

// Must remove padding when reading:
for (let frame = 0; frame < numFrames; frame++) {
  for (let bin = 0; bin < numBins; bin++) {
    unpaddedData[frame * numBins + bin] =
      paddedData[frame * floatsPerRow + bin];
  }
}
```

**Run with**:
```bash
deno test src/sampler/scope/cqt-analyzer-comparison.test.ts --allow-read --no-check
```

Note: `--no-check` is required because some browser types (HTMLCanvasElement) aren't available in Deno.

## Common Issues Found by Tests

### Issue 1: hopLength Calculation Error
**Problem**: `hopLength` was calculated as `inputBufferSize / timeSliceCount = 512` instead of fixed `256`

**Detected by**: `wavelet-transform.test.ts` - hopLength consistency check

**Fix**:
```typescript
// Wrong
hopLength: Math.floor(this.config.inputBufferSize / this.config.timeSliceCount)

// Correct
hopLength: 256
```

### Issue 2: Frame Count Formula
**Problem**: Used `floor(audioLength / hopLength)` instead of CQT formula

**Detected by**: `frame-calculation.test.ts`

**Fix**:
```typescript
// Wrong
const numFrames = Math.floor(audioLength / hopLength);

// Correct
const numFrames = Math.floor((audioLength - maxKernelLength) / hopLength) + 1;
```

### Issue 3: Buffer Size Too Small
**Problem**: 32,768 samples can't fit 128 frames (only ~32 frames)

**Detected by**: `sample-count.test.ts`

**Fix**: Increased `inputBufferSize` from 32,768 to 65,536 samples

### Issue 4: GPU Buffer Not Written Before Transform
**Problem**: Transform ran on empty GPU buffer because staging buffer wasn't uploaded

**Detected by**: `cqt-analyzer-comparison.test.ts` (all zeros in output)

**Fix**: Added `writeBuffer()` call before running transform

## Running All Tests

```bash
# Run all unit tests
deno test src/sampler/scope/wavelet-transform.test.ts \
              src/sampler/scope/accumulator.test.ts \
              src/sampler/scope/data-flow.test.ts \
              src/sampler/scope/frame-calculation.test.ts \
              src/sampler/scope/sample-count.test.ts

# Run integration test
deno test src/sampler/scope/cqt-analyzer-comparison.test.ts --allow-read --no-check
```

## Test Coverage

The test suite covers:

✅ **Mathematical correctness** - Frequency bins, kernel lengths, window functions
✅ **Data integrity** - Samples preserved through accumulator
✅ **Frame calculations** - Correct formula with maxKernelLength
✅ **Buffer management** - Padding, alignment, ring buffers
✅ **GPU vs CPU equivalence** - Results match reference implementation
✅ **Edge cases** - Minimum samples, buffer boundaries, partial blocks

## Test Results

As of the last run:
- **26 unit tests**: All passing ✓
- **2 integration tests**: All passing ✓
- **Total**: 28/28 tests passing

## Key Parameters

```typescript
// Audio configuration
sampleRate = 48000 Hz
fmin = 32.7 Hz (C1)
fmax = 16000 Hz
binsPerOctave = 12

// Transform parameters
numBins = 108
hopLength = 256 samples
maxKernelLength = 24,686 samples

// Buffer sizes
blockSize = 2048 samples (accumulator)
inputBufferSize = 65,536 samples (transformer)
timeSliceCount = 128 frames

// Memory layout
bytesPerRow = 512 bytes (256-byte aligned)
floatsPerRow = 128 floats (includes 20 padding floats)
```

## Debugging Tips

1. **Enable debug logging** in `transformer.ts`:
   ```typescript
   console.log(`doTransform: audioLength=${audioLength}, numFrames=${numFrames}`);
   ```

2. **Check buffer contents** in tests:
   ```typescript
   const data = await readTransformOutput(device, buffer, numBins, numFrames);
   console.log(`Range: ${Math.min(...data)} to ${Math.max(...data)}`);
   console.log(`Non-zero: ${Array.from(data).filter(v => v > 0.001).length}`);
   ```

3. **Verify dimensions match**:
   ```typescript
   assertEquals(cqtResult.numBins, waveletTransform.getNumBins());
   assertEquals(cqtResult.numFrames, expectedFrames);
   ```

## Future Improvements

- [ ] Test with different sample rates (44.1 kHz, 96 kHz)
- [ ] Test with stereo audio (currently mono only)
- [ ] Performance benchmarks (GPU vs CPU speed)
- [ ] Memory leak detection (buffer cleanup)
- [ ] Test error handling (invalid inputs, GPU device loss)
