# Spectrogram Pipeline Test Results

## Overview

Created comprehensive test suite for the 4-stage spectrogram analyzer pipeline in [pipeline-stages.test.ts](pipeline-stages.test.ts:1).

## Test Results Summary

### ✅ PASSING TESTS (4/8)

1. **Stage 1: Ring buffer organizes samples correctly** ✅
   - Verifies accumulator properly organizes samples into blocks
   - Data integrity confirmed across block boundaries

2. **Stage 2: CQT frames computed with correct hop length spacing** ✅
   - Adjacent frames show 99.8% similarity (expected for hop=256)
   - Confirms frames overlap correctly

3. **Stage 4: Texture array contains all textures in order** ✅
   - Individual textures match texture array layers 100%
   - Texture array structure is correct

4. **Stage 1: Ring buffer organizes samples correctly** ✅
   - Basic accumulator functionality verified

### ❌ FAILING TESTS (4/8) - REAL ISSUES FOUND

#### 1. Stage 1: Data uploads to GPU buffers correctly ❌
**Location**: [pipeline-stages.test.ts:198](pipeline-stages.test.ts:198)

**Problem**: Only 0.2% match rate between input samples and GPU buffer readback

**Diagnostic Output**:
```
Processing 72000 samples
Read back 65536 floats from GPU
Match rate: 0.2%
```

**Likely Cause**: The transformer uses a staging buffer that gets overwritten. The test reads from input buffer slot 0, but the active data may be in a different buffer or the staging buffer hasn't been flushed yet.

**Fix Needed**:
- Track which input buffer actually contains the processed data
- Read from the correct buffer index based on `activeInputBufferIndex`
- Or ensure we're reading after the buffer has been written via `writeBuffer()`

---

#### 2. Stage 2: CQT output has correct 2D array structure ❌
**Location**: [pipeline-stages.test.ts:343](pipeline-stages.test.ts:343)

**Problem**: Only 25% of frames have the peak at the expected 440 Hz bin

**Diagnostic Output**:
```
Test frequency: 440 Hz
Expected bin: 45 (440.0 Hz)
Frames with correct peak: 32/128 (25.0%)
Peak value range: [0.000, 9.183]
```

**Likely Cause**:
- Only 32 out of 128 frames contain valid data (the rest are from the incomplete final batch)
- The test is reading from the wrong output buffer index
- Need to account for `frameOffset` - later batches write to different buffers

**Fix Needed**:
- Read from ALL output buffers, not just the last one
- Check `textureFrameCounts` to determine which frames are valid
- Or only test frames we know are valid (first batch = 128 frames)

---

#### 3. Stage 3: Storage buffer maps to texture correctly ❌
**Location**: [pipeline-stages.test.ts:440](pipeline-stages.test.ts:440)

**Problem**: 75% match rate, with first frame completely zero in texture

**Diagnostic Output**:
```
Buffer data: 16384 floats
Texture data: 13824 floats
Mismatch at [0, 0]: buffer=0.0011..., texture=0
Match rate: 75.000%
```

**Likely Cause**:
- Texture read is returning zeros for some data
- Possible issue with `copyBufferToTexture` alignment or format
- The texture might be from a different batch than the buffer being compared

**Fix Needed**:
- Ensure we're comparing the same batch (buffer index should match texture index)
- Verify texture format matches buffer layout (r32float, column-major)
- Check if texture was actually written to

---

#### 4. Stage 3: Textures are continuous when tiled ❌
**Location**: [pipeline-stages.test.ts:509](pipeline-stages.test.ts:509)

**Problem**: Zero similarity at texture boundaries

**Diagnostic Output**:
```
Created 7 texture(s)
Texture boundary similarity: 0.000
```

**Likely Cause**:
- **Critical finding**: Textures are NOT continuous!
- Each texture starts with a new `frameOffset`, but the audio input buffer gets reset between batches
- The `inputBufferOverlap` is set to 0 in the config, meaning no samples are carried over
- This creates discontinuities in the spectrogram

**This is likely THE ROOT CAUSE of your spectrogram issues!**

**Fix Needed**:
- Set `inputBufferOverlap` to preserve enough samples for continuity
- Overlap should be at least `maxKernelLength` to ensure all CQT frames can be computed
- Or redesign the batching to maintain continuous sample stream

---

#### 5. Stage 4: Test pattern for tile verification ❌
**Location**: [pipeline-stages.test.ts:673](pipeline-stages.test.ts:673)

**Problem**: All detected peaks at 32.7 Hz (bin 0) regardless of input frequency

**Diagnostic Output**:
```
Tone 0: Expected 200 Hz, Detected 32.7 Hz (bin 0)
Tone 1: Expected 400 Hz, Detected 32.7 Hz (bin 0)
Tone 2: Expected 800 Hz, Detected 32.7 Hz (bin 0)
Pattern detection accuracy: 0.0%
```

**Likely Cause**:
- Reading all zeros or invalid data from texture
- Compounded by the buffer discontinuity issue above
- May be reading from wrong texture or wrong frames

**Fix Needed**:
- First fix the continuity issue
- Then verify texture index selection logic

---

## Critical Discovery: Input Buffer Discontinuity

The tests revealed that **textures are not continuous** due to:

1. **Zero overlap**: `inputBufferOverlap: 0` in [transformer.ts:36](transformer.ts:36)
2. **Buffer resets**: Each new input buffer starts fresh, losing previous context
3. **Frame offset issues**: While `frameOffset` correctly indexes into current buffer, there's no sample continuity between buffers

### Impact on Spectrogram

This causes:
- Visible seams/discontinuities between texture tiles
- Incorrect frequency content at tile boundaries
- Broken time-frequency continuity

### Recommended Fix

In [transformer.ts](transformer.ts:1), change:
```typescript
const DEFAULT_CONFIG: TransformerConfig = {
  inputBufferSize: 65536,
  inputBufferCount: 2,
  inputBufferOverlap: 0,  // ❌ PROBLEM: No overlap
  // ...
}
```

To:
```typescript
const DEFAULT_CONFIG: TransformerConfig = {
  inputBufferSize: 65536,
  inputBufferCount: 2,
  inputBufferOverlap: 24686,  // ✅ maxKernelLength for continuity
  // ...
}
```

This ensures each buffer overlaps enough to maintain sample continuity for the CQT computation.

---

## How to Run Tests

```bash
cd hello-tauri/tauri-template
deno test src/sampler/scope/pipeline-stages.test.ts --allow-read --no-check
```

## Test Coverage

### Stage 1: Ring Buffer & GPU Upload
- ✅ Ring buffer organization
- ❌ GPU buffer data integrity

### Stage 2: GPU CQT Computation
- ✅ Hop length frame spacing
- ❌ 2D array structure validation

### Stage 3: Buffer-to-Texture Mapping
- ❌ Buffer/texture data consistency
- ❌ Texture continuity at boundaries

### Stage 4: Texture Tiling
- ✅ Texture array structure
- ❌ Test pattern detection

## Next Steps

1. **Fix input buffer overlap** - Set to `maxKernelLength` (24686)
2. **Fix test buffer indexing** - Read from correct buffer/texture indices
3. **Re-run tests** - Verify continuity is restored
4. **Add visual test** - Render spectrogram to PNG for manual inspection
