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
  private textures: GPUTexture[] = [];
  private textureHeight: number; // Rounded up numBins (power of 2)
  private textureWidth: number; // framesPerTexture

  // Input buffer (configured externally)
  private inputBuffer: GPUBuffer | null = null;
  private inputNumBins: number = 0; // Original number of bins in input
  private inputMaxFrames: number = 0; // Maximum frames in input buffer

  // WebGPU resources
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private configured: boolean = false;

  // Ring buffer state
  private writePosition: number = 0; // Current write position (texture index)

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

    // Validate framesPerTexture is power of 2
    if ((this.config.framesPerTexture & (this.config.framesPerTexture - 1)) !== 0) {
      throw new Error(
        `framesPerTexture must be a power of 2, got ${this.config.framesPerTexture}`
      );
    }

    // Calculate texture dimensions
    this.textureWidth = this.config.framesPerTexture;
    this.textureHeight = nextPowerOf2(this.config.numBins);

    // Create texture array
    this.createTextures();

    // Initialize WebGPU resources
    this.initializeWebGPU();
  }

  /**
   * Create the texture array ring buffer
   */
  private createTextures(): void {
    this.textures = [];

    for (let i = 0; i < this.config.textureCount; i++) {
      const texture = this.device.createTexture({
        size: {
          width: this.textureWidth,
          height: this.textureHeight,
          depthOrArrayLayers: 1,
        },
        format: "rgba8unorm", // RGBA format for color, filterable and antialiasable
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });

      this.textures.push(texture);
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
fn magnitudeToColor(magnitude: f32) -> vec4<f32> {
  // Apply logarithmic scaling for better visualization
  // Add small epsilon to avoid log(0)
  let epsilon = 0.0001;
  let logMag = log(magnitude + epsilon);

  // Normalize to 0-1 range (tune these values based on your data)
  let minLog = log(epsilon);
  let maxLog = log(10.0); // Adjust this based on typical magnitude range
  let normalized = clamp((logMag - minLog) / (maxLog - minLog), 0.0, 1.0);

  // Apply a power curve for better contrast
  let intensity = pow(normalized, 0.5);

  // Hot colormap interpolation
  var color: vec3<f32>;

  if (intensity < 0.33) {
    // Black to red
    let t = intensity / 0.33;
    color = vec3<f32>(t, 0.0, 0.0);
  } else if (intensity < 0.66) {
    // Red to yellow
    let t = (intensity - 0.33) / 0.33;
    color = vec3<f32>(1.0, t, 0.0);
  } else {
    // Yellow to white
    let t = (intensity - 0.66) / 0.34;
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

  // Convert magnitude to color
  let color = magnitudeToColor(magnitude);

  // Calculate output texture position
  let outputX = (params.outputStartX + texX) % params.textureWidth;
  let outputY = texY;

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

      // Calculate how many frames fit in current texture
      const currentTextureIndex = this.writePosition % this.config.textureCount;
      const currentTexture = this.textures[currentTextureIndex];
      const textureStartX = Math.floor(framesProcessed / this.textureWidth) * this.textureWidth % this.textureWidth;
      const framesToCopy = Math.min(
        framesRemaining,
        this.textureWidth - textureStartX
      );

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
          { binding: 1, resource: currentTexture.createView() },
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

      // Move to next texture if we filled this one
      if (textureStartX + framesToCopy >= this.textureWidth) {
        this.writePosition = (this.writePosition + 1) % this.config.textureCount;
      }
    }
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
   * Get all textures in the ring buffer
   */
  getTextures(): GPUTexture[] {
    return this.textures;
  }

  /**
   * Get the current write position (texture index)
   */
  getWritePosition(): number {
    return this.writePosition;
  }

  /**
   * Get texture width (frames per texture)
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
   */
  getTotalCapacity(): number {
    return this.config.textureCount * this.textureWidth;
  }

  /**
   * Reset the spectrogram to initial state
   */
  reset(): void {
    this.writePosition = 0;
  }

  /**
   * Cleanup and destroy WebGPU resources
   */
  destroy(): void {
    for (const texture of this.textures) {
      texture.destroy();
    }
    this.textures = [];
    this.configured = false;
    this.inputBuffer = null;
  }
}
