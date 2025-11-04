/**
 * Spectrogram - Manages a ring buffer of WebGPU textures for CQT visualization
 *
 * This class is responsible for:
 * 1. Creating and managing a texture array ring buffer
 * 2. Converting CQT data from storage buffer to textures using compute shaders
 * 3. Managing texture coordinates and ring buffer wrapping
 */

export interface SpectrogramConfig {
  /** Number of textures in the ring buffer */
  textureCount: number;
  /** Number of time frames per texture (must be power of 2, default: 1024) */
  framesPerTexture: number;
  /** Number of frequency bins (will be rounded up to nearest power of 2) */
  numBins: number;
}

/**
 * Round up to the nearest power of 2
 */
function nextPowerOf2(n: number): number {
  if (n <= 0) return 1;
  if ((n & (n - 1)) === 0) return n; // Already a power of 2
  let power = 1;
  while (power < n) {
    power *= 2;
  }
  return power;
}

/**
 * Spectrogram class for managing WebGPU texture ring buffer
 */
export class Spectrogram {
  private device: GPUDevice;
  private config: SpectrogramConfig;

  // Texture properties
  private textures: GPUTexture[] = []; // Legacy: keep for compatibility with tests
  private textureArray: GPUTexture | null = null; // Large 2D texture containing all frames
  private textureHeight: number; // Rounded up numBins (power of 2)
  private textureWidth: number; // Total width (framesPerTexture * textureCount)

  // Input buffer (configured externally)
  private inputBuffer: GPUBuffer | null = null;
  private inputNumBins: number = 0; // Original number of bins in input
  private inputMaxFrames: number = 0; // Maximum frames in input buffer

  // WebGPU resources
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private configured: boolean = false;

  // Ring buffer state
  private writePosition: number = 0; // Current write position in total frames (wraps around)
  private totalFramesWritten: number = 0; // Total frames written (does not wrap)


  /**
   * Create a Spectrogram instance
   * @param device WebGPU device
   * @param config Spectrogram configuration
   */
  constructor(device: GPUDevice, config: Partial<SpectrogramConfig>) {
    this.device = device;

    // Set configuration with defaults
    this.config = {
      textureCount: config.textureCount ?? 8,
      framesPerTexture: config.framesPerTexture ?? 1024,
      numBins: config.numBins ?? 128,
    };

    // For backward compatibility with tests that don't call configure(),
    // set a default texture width based on the old formula
    // This will be overridden in configure() to match the actual input buffer
    this.textureWidth = this.config.framesPerTexture * this.config.textureCount;
    this.textureHeight = nextPowerOf2(this.config.numBins);

    // Create default texture (will be recreated in configure() if size changes)
    this.createTextures();

    // Initialize WebGPU resources (shaders, pipelines)
    this.initializeWebGPU();
  }

  /**
   * Create one large 2D texture
   */
  private createTextures(): void {
    console.log(`Spectrogram: Creating texture ${this.textureWidth}x${this.textureHeight} (${this.config.textureCount} textures of ${this.config.framesPerTexture} frames each)`);

    // Create a single large 2D texture
    this.textureArray = this.device.createTexture({
      size: {
        width: this.textureWidth,
        height: this.textureHeight,
        depthOrArrayLayers: 1,
      },
      format: "rgba8unorm",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });

    // Legacy: populate textures array for backward compatibility with tests
    // Create sub-views that represent the old "ring buffer texture" layout
    const framesPerTexture = this.config.framesPerTexture;
    this.textures = [];
    for (let i = 0; i < this.config.textureCount; i++) {
      // Each "texture" is actually a view into a horizontal slice of the big texture
      // Note: WebGPU doesn't support arbitrary rectangular views, so we just store the main texture
      // Tests will need to account for the horizontal offset when reading
      this.textures.push(this.textureArray);
    }
  }

  /**
   * Initialize WebGPU resources (shader, pipeline, bind group layout)
   */
  private initializeWebGPU(): void {
    // Create bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" }, // Input buffer (CQT data)
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "write-only",
            format: "rgba8unorm",
          }, // Output texture
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" }, // Parameters
        },
      ],
    });

    // Create compute shader
    const shaderModule = this.device.createShaderModule({
      code: this.getBufferToTextureShader(),
    });

    // Create pipeline
    this.pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
    });
  }

  /**
   * Generate WGSL shader code for buffer-to-texture conversion
   */
  private getBufferToTextureShader(): string {
    return `
struct Params {
  inputStartFrame: u32,    // Starting frame in input buffer
  inputNumBins: u32,       // Number of bins in input buffer
  inputMaxFrames: u32,     // Maximum frames in input buffer
  outputStartX: u32,       // Starting X coordinate in output texture
  outputStartY: u32,       // Starting Y coordinate in output texture (should be 0)
  numFramesToCopy: u32,    // Number of frames to copy
  textureWidth: u32,       // Width of output texture
  textureHeight: u32,      // Height of output texture (power of 2)
}

@group(0) @binding(0) var<storage, read> inputBuffer: array<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: Params;

// Convert magnitude to color using a "hot" colormap (black -> red -> yellow -> white)
// Uses linear scaling to match CPU-side saveCQTAsPNG function
fn magnitudeToColor(magnitude: f32, minVal: f32, maxVal: f32) -> vec4<f32> {
  // Linear normalization to 0-1 range
  let range = maxVal - minVal;
  let normalized = clamp((magnitude - minVal) / range, 0.0, 1.0);

  // Hot colormap interpolation
  var color: vec3<f32>;

  // Thresholds: 0-85/255, 85-170/255, 170-255/255
  if (normalized < 0.333333) {
    // Black to red
    let t = normalized / 0.333333;
    color = vec3<f32>(t, 0.0, 0.0);
  } else if (normalized < 0.666667) {
    // Red to yellow
    let t = (normalized - 0.333333) / 0.333333;
    color = vec3<f32>(1.0, t, 0.0);
  } else {
    // Yellow to white
    let t = (normalized - 0.666667) / 0.333333;
    color = vec3<f32>(1.0, 1.0, t);
  }

  return vec4<f32>(color, 1.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let texX = globalId.x;
  let texY = globalId.y;

  // Check bounds
  if (texX >= params.numFramesToCopy || texY >= params.inputNumBins) {
    return;
  }

  // Calculate input buffer position with wrap-around
  let inputFrame = (params.inputStartFrame + texX) % params.inputMaxFrames;
  let inputIdx = inputFrame * params.inputNumBins + texY;

  // Read magnitude value from input buffer
  let magnitude = inputBuffer[inputIdx];

  // Convert magnitude to color using fixed normalization range
  // This matches how saveCQTAsPNG normalizes with min/max
  // For typical CQT output, magnitudes range from 0.0 to ~2.0
  let minVal = 0.0;
  let maxVal = 2.0;
  let color = magnitudeToColor(magnitude, minVal, maxVal);

  // Calculate output texture position
  let outputX = params.outputStartX + texX;
  // Flip Y coordinate so low frequencies are at bottom (high Y values)
  let outputY = params.inputNumBins - 1u - texY;

  // Write color to output texture
  textureStore(outputTexture, vec2<i32>(i32(outputX), i32(outputY)), color);
}
`;
  }

  /**
   * Configure the spectrogram with input buffer
   * @param inputBuffer GPU buffer containing CQT data (2D: [time][frequency])
   * @param numBins Number of frequency bins in the input buffer
   * @param maxFrames Maximum number of time frames in the input buffer
   */
  configure(
    inputBuffer: GPUBuffer,
    numBins: number,
    maxFrames: number
  ): void {
    if (!this.pipeline || !this.bindGroupLayout) {
      throw new Error("Spectrogram not properly initialized");
    }

    // Set texture width to match input buffer size
    this.textureWidth = maxFrames;
    this.textureHeight = nextPowerOf2(numBins);

    console.log(`Spectrogram.configure: Creating texture with width=${this.textureWidth} to match input maxFrames=${maxFrames}`);

    // Create or recreate texture with correct dimensions
    if (this.textureArray) {
      this.textureArray.destroy();
    }
    this.createTextures();

    this.inputBuffer = inputBuffer;
    this.inputNumBins = numBins;
    this.inputMaxFrames = maxFrames;
    this.configured = true;
  }

  /**
   * Update textures with data from input buffer
   * @param startFrame Starting frame in input buffer
   * @param endFrame Ending frame in input buffer (exclusive)
   */
  updateTextures(startFrame: number, endFrame: number): void {
    if (!this.configured || !this.inputBuffer) {
      throw new Error("Spectrogram not configured. Call configure() first.");
    }

    if (!this.pipeline || !this.bindGroupLayout) {
      throw new Error("Spectrogram pipeline not initialized");
    }

    // Calculate number of frames to copy
    let numFrames = endFrame - startFrame;
    if (numFrames <= 0) {
      return; // Nothing to copy
    }

    // Handle wrap-around in input buffer
    if (endFrame > this.inputMaxFrames) {
      // Split into two calls if wrapping
      this.updateTextures(startFrame, this.inputMaxFrames);
      this.updateTextures(0, endFrame % this.inputMaxFrames);
      return;
    }

    // Process frames in chunks that fit into textures
    let framesProcessed = 0;
    while (framesProcessed < numFrames) {
      const currentInputFrame = (startFrame + framesProcessed) % this.inputMaxFrames;
      const framesRemaining = numFrames - framesProcessed;

      // Calculate X position in the large texture
      const absoluteWritePos = (this.writePosition + framesProcessed) % this.getTotalCapacity();
      const textureStartX = absoluteWritePos;
      const framesToCopy = Math.min(
        framesRemaining,
        this.textureWidth - textureStartX
      );

      // Log first few writes
      if (this.totalFramesWritten < 100) {
        console.log(`Spectrogram.updateTextures: writing ${framesToCopy} frames to X=${textureStartX}, totalWritten=${this.totalFramesWritten}, writePosition=${this.writePosition}`);
      }

      // Create parameters buffer
      const paramsData = new Uint32Array([
        currentInputFrame,
        this.inputNumBins,
        this.inputMaxFrames,
        textureStartX,
        0, // outputStartY (always 0)
        framesToCopy,
        this.textureWidth,
        this.textureHeight,
      ]);

      const paramsBuffer = this.device.createBuffer({
        size: paramsData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(paramsBuffer, 0, paramsData);

      // Create bind group for this operation
      const bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.inputBuffer } },
          { binding: 1, resource: this.textureArray!.createView() },
          { binding: 2, resource: { buffer: paramsBuffer } },
        ],
      });

      // Create command encoder and dispatch compute shader
      const commandEncoder = this.device.createCommandEncoder();
      const passEncoder = commandEncoder.beginComputePass();

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, bindGroup);

      // Dispatch: 1 thread per (x, y) coordinate
      const workgroupsX = Math.ceil(framesToCopy / 8);
      const workgroupsY = Math.ceil(this.inputNumBins / 8);
      passEncoder.dispatchWorkgroups(workgroupsX, workgroupsY, 1);

      passEncoder.end();

      // Submit commands
      this.device.queue.submit([commandEncoder.finish()]);

      // Cleanup temporary buffer
      paramsBuffer.destroy();

      // Update state
      framesProcessed += framesToCopy;
    }

    // Update write position by the total number of frames written
    this.writePosition = (this.writePosition + numFrames) % this.getTotalCapacity();
    this.totalFramesWritten += numFrames;
  }

  /**
   * Get a specific texture from the ring buffer
   * @param index Texture index (0 to textureCount-1)
   */
  getTexture(index: number): GPUTexture {
    if (index < 0 || index >= this.textures.length) {
      throw new Error(`Texture index ${index} out of range [0, ${this.textures.length - 1}]`);
    }
    return this.textures[index];
  }

  /**
   * Get all textures in the ring buffer (legacy compatibility)
   */
  getTextures(): GPUTexture[] {
    return this.textures;
  }

  /**
   * Get the texture array (preferred method for rendering with texture_2d_array)
   */
  getTextureArray(): GPUTexture {
    if (!this.textureArray) {
      throw new Error("Texture array not initialized");
    }
    return this.textureArray;
  }

  /**
   * Get the current write position (texture index)
   */
  getWritePosition(): number {
    return Math.floor(this.writePosition / this.config.framesPerTexture) % this.config.textureCount;
  }

  /**
   * Get the current write position in frames (0 to totalCapacity-1)
   */
  getWritePositionInFrames(): number {
    return this.writePosition;
  }

  /**
   * Get the number of frames written so far (clamped to capacity, not wrapped)
   */
  getFramesWritten(): number {
    return Math.min(this.totalFramesWritten, this.getTotalCapacity());
  }

  /**
   * Get texture width (actual texture width in pixels)
   */
  getTextureWidth(): number {
    return this.textureWidth;
  }

  /**
   * Get texture height (rounded up number of bins)
   */
  getTextureHeight(): number {
    return this.textureHeight;
  }

  /**
   * Get the number of textures in the ring buffer
   */
  getTextureCount(): number {
    return this.config.textureCount;
  }

  /**
   * Get the total capacity in frames (textureCount * framesPerTexture)
   * Note: textureWidth is already the full width (textureCount * framesPerTexture)
   */
  getTotalCapacity(): number {
    return this.textureWidth;
  }

  /**
   * Reset the spectrogram to initial state
   */
  reset(): void {
    this.writePosition = 0;
    this.totalFramesWritten = 0;

    // Clear the texture to black by writing zeros
    if (this.textureArray) {
      // Create a buffer full of zeros
      const bytesPerPixel = 4; // RGBA8
      const bufferSize = this.textureWidth * this.textureHeight * bytesPerPixel;
      const zeroData = new Uint8Array(bufferSize);

      // Write zeros to texture via a staging buffer
      const commandEncoder = this.device.createCommandEncoder();

      // We need to use writeTexture, but it requires proper alignment
      // For simplicity, just write black rows
      const bytesPerRow = Math.ceil((this.textureWidth * bytesPerPixel) / 256) * 256;
      const alignedData = new Uint8Array(bytesPerRow * this.textureHeight);

      this.device.queue.writeTexture(
        { texture: this.textureArray },
        alignedData,
        { bytesPerRow, rowsPerImage: this.textureHeight },
        { width: this.textureWidth, height: this.textureHeight }
      );

      console.log("Spectrogram: Texture cleared on reset");
    }
  }

  /**
   * Cleanup and destroy WebGPU resources
   */
  destroy(): void {
    if (this.textureArray) {
      this.textureArray.destroy();
      this.textureArray = null;
    }
    this.textures = [];
    this.configured = false;
    this.inputBuffer = null;
  }
}
