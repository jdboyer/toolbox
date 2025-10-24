/**
 * Simple PNG writer for saving CQT output as grayscale images
 * Uses uncompressed PNG format for simplicity
 */

/**
 * Calculate CRC32 checksum (required for PNG chunks)
 */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  const table = new Uint32Array(256);

  // Build CRC table
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }

  // Calculate CRC
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }

  return crc ^ 0xffffffff;
}

/**
 * Write a PNG chunk
 */
function writeChunk(
  type: string,
  data: Uint8Array
): Uint8Array {
  const length = data.length;
  const chunk = new Uint8Array(12 + length);
  const view = new DataView(chunk.buffer);

  // Length (4 bytes, big-endian)
  view.setUint32(0, length, false);

  // Chunk type (4 bytes)
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = type.charCodeAt(i);
  }

  // Data
  chunk.set(data, 8);

  // CRC (4 bytes, big-endian)
  const crcData = chunk.slice(4, 8 + length);
  const crc = crc32(crcData);
  view.setUint32(8 + length, crc, false);

  return chunk;
}

/**
 * Save a 2D float array as a grayscale PNG image
 *
 * @param data - 2D data in row-major order
 * @param width - Image width (number of columns)
 * @param height - Image height (number of rows)
 * @param filePath - Output file path
 * @param normalize - Whether to normalize data to [0, 255] range
 */
export async function savePNG(
  data: Float32Array,
  width: number,
  height: number,
  filePath: string,
  normalize: boolean = true
): Promise<void> {
  // Find min/max for normalization
  let minVal = data[0];
  let maxVal = data[0];

  if (normalize) {
    for (let i = 0; i < data.length; i++) {
      minVal = Math.min(minVal, data[i]);
      maxVal = Math.max(maxVal, data[i]);
    }
  }

  const range = maxVal - minVal;

  // Convert to 8-bit grayscale
  const imageData = new Uint8Array(height * (width + 1));

  for (let y = 0; y < height; y++) {
    // Filter type (0 = none)
    imageData[y * (width + 1)] = 0;

    // Pixel data
    for (let x = 0; x < width; x++) {
      const value = data[y * width + x];
      let normalized: number;

      if (normalize && range > 0) {
        normalized = ((value - minVal) / range) * 255;
      } else {
        normalized = Math.max(0, Math.min(255, value));
      }

      imageData[y * (width + 1) + 1 + x] = Math.floor(normalized);
    }
  }

  // Compress data (use uncompressed DEFLATE blocks for simplicity)
  const compressed = zlibCompress(imageData);

  // Build PNG file
  const chunks: Uint8Array[] = [];

  // PNG signature
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  chunks.push(signature);

  // IHDR chunk
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false); // Width
  ihdrView.setUint32(4, height, false); // Height
  ihdr[8] = 8; // Bit depth
  ihdr[9] = 0; // Color type (grayscale)
  ihdr[10] = 0; // Compression method
  ihdr[11] = 0; // Filter method
  ihdr[12] = 0; // Interlace method
  chunks.push(writeChunk("IHDR", ihdr));

  // IDAT chunk
  chunks.push(writeChunk("IDAT", compressed));

  // IEND chunk
  chunks.push(writeChunk("IEND", new Uint8Array(0)));

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const png = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.length;
  }

  // Write to file
  await Deno.writeFile(filePath, png);
}

/**
 * Simple uncompressed DEFLATE compression
 * (Real implementation would use zlib, but this works for testing)
 */
function zlibCompress(data: Uint8Array): Uint8Array {
  const maxBlockSize = 65535;
  const numBlocks = Math.ceil(data.length / maxBlockSize);
  const output: Uint8Array[] = [];

  // Zlib header (CMF + FLG)
  output.push(new Uint8Array([0x78, 0x01]));

  // DEFLATE blocks
  for (let i = 0; i < numBlocks; i++) {
    const start = i * maxBlockSize;
    const end = Math.min(start + maxBlockSize, data.length);
    const blockSize = end - start;
    const isLast = i === numBlocks - 1;

    const block = new Uint8Array(5 + blockSize);
    const view = new DataView(block.buffer);

    // Block header
    block[0] = isLast ? 1 : 0; // BFINAL + BTYPE (00 = uncompressed)
    view.setUint16(1, blockSize, true); // LEN
    view.setUint16(3, ~blockSize & 0xffff, true); // NLEN

    // Block data
    block.set(data.slice(start, end), 5);

    output.push(block);
  }

  // Adler-32 checksum
  const adler = adler32(data);
  const adlerBytes = new Uint8Array(4);
  new DataView(adlerBytes.buffer).setUint32(0, adler, false);
  output.push(adlerBytes);

  // Concatenate
  const totalLength = output.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of output) {
    result.set(arr, offset);
    offset += arr.length;
  }

  return result;
}

/**
 * Calculate Adler-32 checksum
 */
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD_ADLER = 65521;

  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }

  return (b << 16) | a;
}

/**
 * Save raw binary data (alternative to PNG)
 */
export async function saveRawBinary(
  data: Float32Array,
  width: number,
  height: number,
  filePath: string
): Promise<void> {
  // Create header with metadata
  const header = new Uint32Array([
    0x43515446, // Magic number "CQTF"
    1, // Version
    width,
    height,
  ]);

  // Combine header and data
  const totalBytes = header.byteLength + data.byteLength;
  const buffer = new Uint8Array(totalBytes);
  buffer.set(new Uint8Array(header.buffer), 0);
  buffer.set(new Uint8Array(data.buffer), header.byteLength);

  await Deno.writeFile(filePath, buffer);
}

/**
 * Read raw binary CQT data
 */
export async function readRawBinary(filePath: string): Promise<{
  data: Float32Array;
  width: number;
  height: number;
}> {
  const buffer = await Deno.readFile(filePath);
  const view = new DataView(buffer.buffer, buffer.byteOffset);

  // Check magic number
  const magic = view.getUint32(0, true);
  if (magic !== 0x43515446) {
    throw new Error("Invalid CQT binary file");
  }

  // Read header
  const version = view.getUint32(4, true);
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);

  // Read data
  const dataOffset = 16;
  const data = new Float32Array(
    buffer.buffer,
    buffer.byteOffset + dataOffset,
    width * height
  );

  return { data: new Float32Array(data), width, height };
}
