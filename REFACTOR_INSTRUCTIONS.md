# Spectrogram Refactoring Instructions

## Current State

The spectrogram is now working and displays the entire audio file, but has **time discontinuities** between texture tiles. This is because we're not computing all possible frames from each input buffer.

## The Problem

### Current Behavior
- Input buffer size: 65,536 samples
- Frames computed per buffer: 128 frames
- Samples covered by 128 frames: 128 × 256 (hopLength) = 32,768 samples
- **Gap between textures: 65,536 - 32,768 = 32,768 samples (~0.68 seconds at 48kHz)**

### Why This Happens
With hopLength=256 and maxKernelLength=24,686:
- Maximum possible frames from 65,536 samples: `(65,536 - 24,686) / 256 + 1 ≈ 160 frames`
- But we only compute 128 frames per texture (limited by `timeSliceCount=128`)
- The remaining ~32 frames worth of audio data is never transformed
- This creates visible discontinuities between texture boundaries

## The Solution

### Option 1: Compute Multiple Textures Per Input Buffer (Recommended)

Modify the transformer to compute ALL possible frames from each input buffer, distributing them across multiple textures:

1. **In `doTransform()` method** (`transformer.ts:~393`):
   - Calculate max possible frames: `maxFrames = floor((audioLength - maxKernelLength) / hopLength) + 1`
   - Compute frames in batches of 128 (timeSliceCount)
   - Create multiple textures if needed (e.g., 160 frames → 2 textures: 128 + 32 frames)

2. **Implementation Steps**:
   ```typescript
   private doTransform(): void {
     const audioLength = this.activeInputBufferOffset;
     const hopLength = this.waveletTransform.getHopLength();
     const maxKernelLength = this.waveletTransform.getMaxKernelLength();

     // Calculate total frames we can compute from this buffer
     const totalFrames = Math.floor((audioLength - maxKernelLength) / hopLength) + 1;

     // Process in batches of timeSliceCount (128)
     let frameOffset = 0;
     while (frameOffset < totalFrames) {
       const numFrames = Math.min(this.config.timeSliceCount, totalFrames - frameOffset);

       // TODO: Modify CQT to start computing at frameOffset
       // TODO: Create output buffer and texture for this batch
       // TODO: Advance texture ring buffer write index

       frameOffset += numFrames;
     }
   }
   ```

3. **CQT Modification Required**:
   - Add `frameOffset` parameter to `computeTransform()`
   - Modify shader to compute frames starting at `frameOffset` instead of 0
   - Shader change: `let frameStart = (frame + frameOffset) * params.hopLength;`

### Option 2: Increase Input Buffer Size

Simpler but less memory efficient:

1. Calculate required buffer size for continuous coverage:
   - For 128 frames: `requiredSize = (128 - 1) × 256 + 24,686 = 57,198 samples`
   - Round to power of 2: already at 65,536 (too big for 128 frames)

2. OR reduce `timeSliceCount` to match buffer size:
   - `timeSliceCount = floor((65,536 - 24,686) / 256) + 1 = 160`
   - But this changes texture dimensions and might exceed GPU limits

### Option 3: Reduce Input Buffer Size

Make input buffers exactly match the frame coverage:

1. Change `inputBufferSize` from 65,536 to 57,198 (or nearest power of 2: 32,768)
2. With 32,768 samples:
   - Max frames: `(32,768 - 24,686) / 256 + 1 ≈ 32 frames`
   - This creates many small textures, which is inefficient

## Recommended Approach

**Implement Option 1**: Compute multiple textures per input buffer.

### Why This is Best
- ✅ No wasted audio data - all samples are transformed
- ✅ Maintains efficient buffer size (65,536 samples)
- ✅ Maintains optimal texture size (128 frames)
- ✅ Perfect time continuity across entire spectrogram
- ✅ Scalable to any audio file length

### Files to Modify

1. **`transformer.ts`**:
   - Modify `doTransform()` to loop and create multiple textures per buffer
   - Track frame offset within each input buffer

2. **`wavelet-transform.ts`**:
   - Add `frameOffset` parameter to `computeTransform()`
   - Update shader params struct to include `frameOffset`
   - Modify shader: `let frameStart = (frame + params.frameOffset) * params.hopLength;`

3. **`scope-renderer.ts`**:
   - Shader already handles variable texture count correctly
   - No changes needed (already displaying textures sequentially)

## Additional Notes

- Current workaround: `inputBufferOverlap = 0` prevents duplicate transforms
- `globalSampleOffset` variable was added but isn't currently used (can be removed or used for frame offset calculation)
- The texture ring buffer can hold 256 textures, so plenty of room for multiple textures per input buffer

## Testing

After implementing the fix:
1. Load a test audio file with a clear transient at the start
2. Verify only ONE transient appears (not repeated)
3. Verify continuous patterns flow smoothly across the entire width
4. Check that total time displayed matches audio file duration
5. Visual test: horizontal patterns should be continuous with no vertical jumps
