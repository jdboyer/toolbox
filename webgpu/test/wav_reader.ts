/**
 * Simple WAV file reader for testing
 * Supports PCM format WAV files
 */

export interface WavData {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  audioData: Float32Array;
}

/**
 * Read a WAV file and return decoded audio data
 */
export async function readWavFile(filePath: string): Promise<WavData> {
  const data = await Deno.readFile(filePath);
  return parseWav(data);
}

/**
 * Parse WAV file from buffer
 */
export function parseWav(buffer: Uint8Array): WavData {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Check RIFF header
  const riff = String.fromCharCode(...buffer.slice(0, 4));
  if (riff !== "RIFF") {
    throw new Error("Not a valid WAV file: missing RIFF header");
  }

  // Check WAVE format
  const wave = String.fromCharCode(...buffer.slice(8, 12));
  if (wave !== "WAVE") {
    throw new Error("Not a valid WAV file: missing WAVE format");
  }

  // Find fmt chunk
  let offset = 12;
  let fmtChunkSize = 0;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;

  while (offset < buffer.length) {
    const chunkId = String.fromCharCode(...buffer.slice(offset, offset + 4));
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === "fmt ") {
      fmtChunkSize = chunkSize;
      audioFormat = view.getUint16(offset + 8, true);
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);

      if (audioFormat !== 1) {
        throw new Error(
          `Unsupported audio format: ${audioFormat} (only PCM is supported)`
        );
      }

      offset += 8 + chunkSize;
    } else if (chunkId === "data") {
      // Found data chunk
      const dataSize = chunkSize;
      const dataOffset = offset + 8;

      // Read audio samples
      const numSamples = dataSize / (bitsPerSample / 8);
      const audioData = new Float32Array(numSamples);

      if (bitsPerSample === 16) {
        // 16-bit PCM
        for (let i = 0; i < numSamples; i++) {
          const sample = view.getInt16(dataOffset + i * 2, true);
          audioData[i] = sample / 32768.0;
        }
      } else if (bitsPerSample === 8) {
        // 8-bit PCM (unsigned)
        for (let i = 0; i < numSamples; i++) {
          const sample = view.getUint8(dataOffset + i);
          audioData[i] = (sample - 128) / 128.0;
        }
      } else if (bitsPerSample === 24) {
        // 24-bit PCM
        for (let i = 0; i < numSamples; i++) {
          const byte1 = view.getUint8(dataOffset + i * 3);
          const byte2 = view.getUint8(dataOffset + i * 3 + 1);
          const byte3 = view.getInt8(dataOffset + i * 3 + 2);
          const sample = (byte3 << 16) | (byte2 << 8) | byte1;
          audioData[i] = sample / 8388608.0;
        }
      } else if (bitsPerSample === 32) {
        // 32-bit PCM
        for (let i = 0; i < numSamples; i++) {
          const sample = view.getInt32(dataOffset + i * 4, true);
          audioData[i] = sample / 2147483648.0;
        }
      } else {
        throw new Error(`Unsupported bit depth: ${bitsPerSample}`);
      }

      return {
        sampleRate,
        numChannels,
        bitsPerSample,
        audioData,
      };
    } else {
      // Skip unknown chunk
      offset += 8 + chunkSize;
    }
  }

  throw new Error("No data chunk found in WAV file");
}

/**
 * Convert stereo to mono by averaging channels
 */
export function stereoToMono(stereoData: Float32Array, numChannels: number): Float32Array {
  if (numChannels === 1) {
    return stereoData;
  }

  const numSamples = stereoData.length / numChannels;
  const monoData = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      sum += stereoData[i * numChannels + ch];
    }
    monoData[i] = sum / numChannels;
  }

  return monoData;
}

/**
 * Generate a test WAV file with a sine wave
 */
export function generateTestWav(
  frequency: number,
  duration: number,
  sampleRate: number = 44100
): Uint8Array {
  const numSamples = Math.floor(duration * sampleRate);
  const dataSize = numSamples * 2; // 16-bit samples

  // WAV file structure
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + dataSize, true); // File size - 8
  view.setUint32(8, 0x57415645, false); // "WAVE"

  // fmt chunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true); // Chunk size
  view.setUint16(20, 1, true); // Audio format (PCM)
  view.setUint16(22, 1, true); // Num channels (mono)
  view.setUint32(24, sampleRate, true); // Sample rate
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample

  // data chunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataSize, true); // Data size

  // Generate sine wave
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequency * t);
    const value = Math.floor(sample * 32767);
    view.setInt16(44 + i * 2, value, true);
  }

  return new Uint8Array(buffer);
}
