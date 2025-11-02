import type { Analyzer } from "./analyzer";

/**
 * SIMPLE SPECTROGRAM RENDERER
 * - One full-screen quad
 * - Fragment shader samples texture array by UV (u=time, v=frequency)
 * - That's it.
 */
export class ScopeRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private spectrogramTexture: GPUTexture | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private animationFrameId: number | null = null;
  private isRendering = false;

  // Texture dimensions
  private readonly TEXTURE_WIDTH = 1024;  // Time axis (number of columns)
  private readonly TEXTURE_HEIGHT = 256;  // Frequency axis (number of bins)

  // Track how many columns have been filled
  private filledColumns = 0;
  private lastRenderColumn = -1;

  // Time axis parameters (in milliseconds for timeRange/timeOffset)
  private timeRange = 6000; // ms - show 6 seconds by default
  private timeOffset = 0; // ms
  private sampleRate = 48000; // Hz
  private hopLength = 512; // samples per frame
  private actualSampleCount = 0; // Actual audio samples (excluding padding)

  constructor(device: GPUDevice, _analyzer: Analyzer) {
    this.device = device;
    this.format = navigator.gpu?.getPreferredCanvasFormat() || "bgra8unorm";
  }

  async initialize(canvas: HTMLCanvasElement): Promise<boolean> {
    console.log("ScopeRenderer: Initializing");

    // Get canvas context
    this.context = canvas.getContext("webgpu");
    if (!this.context) {
      console.error("Failed to get WebGPU context");
      return false;
    }
    console.log("ScopeRenderer: Got WebGPU context");

    // Configure canvas
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
    });
    console.log("ScopeRenderer: Configured canvas with format:", this.format);

    // Create spectrogram texture (RGBA, 16-bit float is filterable for textureSample)
    this.spectrogramTexture = this.device.createTexture({
      label: "spectrogram-texture",
      size: [this.TEXTURE_WIDTH, this.TEXTURE_HEIGHT, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    console.log("ScopeRenderer: Created texture");

    // Create uniform buffer for UV parameters
    this.uniformBuffer = this.device.createBuffer({
      label: "uniform-buffer",
      size: 16,  // 3 f32s + padding (uvScaleX, uvOffsetX, uvRangeX, padding)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    console.log("ScopeRenderer: Created uniform buffer");

    // Create pipeline and bind group
    await this.createPipeline();
    console.log("ScopeRenderer: Created pipeline");

    this.createBindGroup();
    console.log("ScopeRenderer: Created bind group");

    return true;
  }

  private async createPipeline() {
    // Vertex shader: full-screen quad with UVs
    const vertexShader = `
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
      };

      struct Uniforms {
        uvScaleX: f32,    // Scale UV.x to only sample filled portion
        uvOffsetX: f32,   // Offset UV.x for time scrolling
        uvRangeX: f32,    // Range of UV.x to display (for zoom)
      };
      @group(0) @binding(2) var<uniform> uniforms: Uniforms;

      @vertex
      fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
        var pos = array<vec2<f32>, 6>(
          vec2<f32>(-1.0, -1.0),
          vec2<f32>(1.0, -1.0),
          vec2<f32>(-1.0, 1.0),
          vec2<f32>(-1.0, 1.0),
          vec2<f32>(1.0, -1.0),
          vec2<f32>(1.0, 1.0),
        );

        var uv = array<vec2<f32>, 6>(
          vec2<f32>(0.0, 0.0),  // Bottom left - low frequency
          vec2<f32>(1.0, 0.0),  // Bottom right
          vec2<f32>(0.0, 1.0),  // Top left - high frequency
          vec2<f32>(0.0, 1.0),  // Top left
          vec2<f32>(1.0, 0.0),  // Bottom right
          vec2<f32>(1.0, 1.0),  // Top right
        );

        var output: VertexOutput;
        output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);

        // Map screen UV (0-1) to texture UV based on time axis
        // 1. Apply zoom (uvRangeX)
        // 2. Apply scroll offset (uvOffsetX)
        // 3. Scale to filled portion (uvScaleX)
        let texU = (uv[vertexIndex].x * uniforms.uvRangeX + uniforms.uvOffsetX) * uniforms.uvScaleX;
        output.uv = vec2<f32>(texU, uv[vertexIndex].y);
        return output;
      }
    `;

    // Fragment shader: sample texture at UV
    const fragmentShader = `
      @group(0) @binding(0) var spectrogramTexture: texture_2d<f32>;
      @group(0) @binding(1) var spectrogramSampler: sampler;

      fn valueToColor(value: f32) -> vec3<f32> {
        // Apply power scaling to compress dynamic range
        // Power of 0.6 gives more detail in lower values
        let logValue = pow(value, 0.5);
        let v = clamp(logValue, 0.0, 1.0);

        // Hot colormap: black -> red -> yellow -> white
        // Only the very brightest values reach white
        if (v < 0.4) {
          // Black to red
          let t = v / 0.4;
          return vec3<f32>(t, 0.0, 0.0);
        } else if (v < 0.8) {
          // Red to yellow
          let t = (v - 0.4) / 0.4;
          return vec3<f32>(1.0, t, 0.0);
        } else {
          // Yellow to white (only top 20%)
          let t = (v - 0.8) / 0.2;
          return vec3<f32>(1.0, 1.0, t);
        }
      }

      @fragment
      fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
        // Sample texture (u=time, v=frequency)
        let sample = textureSample(spectrogramTexture, spectrogramSampler, uv);
        let magnitude = sample.r;

        // Apply frequency-dependent scaling
        // Low frequencies (v near 0) have more energy, so scale them down more aggressively
        // High frequencies (v near 1) scale them up to be more visible
        // Using a power curve: higher frequencies get boosted
        let freqWeight = pow(uv.y, 0.3) * 5.0 + 0.1; // Range from ~0.1 (low freq) to ~5.1 (high freq)

        // Scale down overall to reduce brightness
        let scaledMagnitude = magnitude * freqWeight * 0.5;

        // Convert to color
        let color = valueToColor(scaledMagnitude);
        return vec4<f32>(color, 1.0);
      }
    `;

    const vertexModule = this.device.createShaderModule({
      label: "vertex-shader",
      code: vertexShader
    });
    const fragmentModule = this.device.createShaderModule({
      label: "fragment-shader",
      code: fragmentShader
    });

    // Check for shader compilation errors
    const vertexInfo = await vertexModule.getCompilationInfo();
    if (vertexInfo.messages.length > 0) {
      console.error("Vertex shader compilation messages:");
      vertexInfo.messages.forEach(msg => console.error(msg));
    }

    const fragmentInfo = await fragmentModule.getCompilationInfo();
    if (fragmentInfo.messages.length > 0) {
      console.error("Fragment shader compilation messages:");
      fragmentInfo.messages.forEach(msg => console.error(msg));
    }

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: vertexModule,
        entryPoint: "main",
      },
      fragment: {
        module: fragmentModule,
        entryPoint: "main",
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  private createBindGroup() {
    if (!this.pipeline || !this.spectrogramTexture || !this.uniformBuffer) return;

    // Create sampler
    const sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: this.spectrogramTexture.createView(),
        },
        {
          binding: 1,
          resource: sampler,
        },
        {
          binding: 2,
          resource: {
            buffer: this.uniformBuffer,
          },
        },
      ],
    });
  }

  /**
   * Write a column of frequency data to the texture
   * @param columnIndex Which time slice (0 to TEXTURE_WIDTH-1)
   * @param frequencyData Array of frequency magnitudes (length = TEXTURE_HEIGHT)
   */
  writeColumn(columnIndex: number, frequencyData: Float32Array) {
    if (!this.spectrogramTexture) return;

    // Track max column filled
    this.filledColumns = Math.max(this.filledColumns, columnIndex + 1);

    // Trigger a single render after writing
    const needsRender = !this.lastRenderColumn || columnIndex > this.lastRenderColumn;
    this.lastRenderColumn = columnIndex;

    // For rgba16float: 4 channels * 2 bytes per f16 = 8 bytes per pixel
    // We need to convert Float32 to Float16 (Uint16 representation)
    const dataU16 = new Uint16Array(this.TEXTURE_HEIGHT * 4);

    for (let i = 0; i < this.TEXTURE_HEIGHT; i++) {
      const mag = frequencyData[i] || 0;
      dataU16[i * 4 + 0] = this.float32ToFloat16(mag);  // R = magnitude
      dataU16[i * 4 + 1] = this.float32ToFloat16(0);    // G
      dataU16[i * 4 + 2] = this.float32ToFloat16(0);    // B
      dataU16[i * 4 + 3] = this.float32ToFloat16(1);    // A
    }

    // Write column to texture
    // Writing 1 pixel wide x TEXTURE_HEIGHT tall
    // bytesPerRow = 1 pixel * 4 channels * 2 bytes = 8 bytes (must be multiple of 256)
    // WebGPU requires bytesPerRow to be a multiple of 256
    const bytesPerRow = 256;  // Minimum required alignment

    // Create aligned buffer
    const rowsNeeded = this.TEXTURE_HEIGHT;
    const alignedBuffer = new Uint8Array(bytesPerRow * rowsNeeded);

    // Copy data row by row
    const sourceView = new Uint8Array(dataU16.buffer);
    for (let row = 0; row < this.TEXTURE_HEIGHT; row++) {
      const srcOffset = row * 8;  // 8 bytes per pixel
      const dstOffset = row * bytesPerRow;
      alignedBuffer.set(sourceView.subarray(srcOffset, srcOffset + 8), dstOffset);
    }

    this.device.queue.writeTexture(
      { texture: this.spectrogramTexture, origin: [columnIndex, 0, 0] },
      alignedBuffer,
      {
        bytesPerRow: bytesPerRow,
        rowsPerImage: this.TEXTURE_HEIGHT
      },
      [1, this.TEXTURE_HEIGHT, 1]
    );

    // Render once after writing data
    if (needsRender) {
      this.render();
    }
  }

  /**
   * Convert Float32 to Float16 (returns Uint16 representation)
   */
  private float32ToFloat16(value: number): number {
    // Simple float32 to float16 conversion
    const f32 = new Float32Array([value]);
    const u32 = new Uint32Array(f32.buffer)[0];

    const sign = (u32 >> 31) & 0x1;
    const exp = (u32 >> 23) & 0xff;
    const frac = u32 & 0x7fffff;

    if (exp === 0) return (sign << 15);  // Zero/denormal
    if (exp === 0xff) return (sign << 15) | 0x7c00;  // Inf/NaN

    const newExp = exp - 127 + 15;
    if (newExp >= 31) return (sign << 15) | 0x7c00;  // Overflow to inf
    if (newExp <= 0) return (sign << 15);  // Underflow to zero

    return (sign << 15) | (newExp << 10) | (frac >> 13);
  }

  startRendering() {
    // Don't start continuous rendering - we'll just render once when data changes
    console.log("ScopeRenderer: Render on demand only");
  }

  stopRendering() {
    this.isRendering = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private frameCount = 0;
  private lastFilledColumns = 0;

  private renderFrame = () => {
    this.frameCount++;

    // Only log when data changes or every 60 frames
    if (this.lastFilledColumns !== this.filledColumns) {
      console.log("ScopeRenderer: Data changed, filledColumns:", this.filledColumns);
      this.lastFilledColumns = this.filledColumns;
    } else if (this.frameCount % 300 === 0) {
      console.log("ScopeRenderer: Still rendering (frame", this.frameCount, ")");
    }

    if (!this.isRendering || !this.context || !this.pipeline || !this.bindGroup || !this.uniformBuffer) {
      console.error("ScopeRenderer: Cannot render - missing:", {
        isRendering: this.isRendering,
        hasContext: !!this.context,
        hasPipeline: !!this.pipeline,
        hasBindGroup: !!this.bindGroup,
        hasUniformBuffer: !!this.uniformBuffer
      });
      return;
    }

    try {
      // Update uniform buffer with UV scale
      const uvScaleX = this.filledColumns > 0 ? this.filledColumns / this.TEXTURE_WIDTH : 1.0;
      const uniformData = new Float32Array([uvScaleX, 0, 0, 0]);
      this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

      const commandEncoder = this.device.createCommandEncoder();
      const textureView = this.context.getCurrentTexture().createView();

      const passEncoder = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: textureView,
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.draw(6);
      passEncoder.end();

      this.device.queue.submit([commandEncoder.finish()]);
    } catch (error) {
      console.error("ScopeRenderer: Render error:", error);
      this.stopRendering();
      return;
    }

    if (this.isRendering) {
      this.animationFrameId = requestAnimationFrame(this.renderFrame);
    }
  };

  render() {
    if (!this.context || !this.pipeline || !this.bindGroup || !this.uniformBuffer) return;

    try {
      // Calculate time axis mapping
      // Total duration of spectrogram in seconds (use actualSampleCount if available)
      const totalDurationSeconds = this.actualSampleCount > 0
        ? this.actualSampleCount / this.sampleRate
        : (this.filledColumns * this.hopLength) / this.sampleRate;

      // Convert timeRange and timeOffset from ms to seconds
      const timeRangeSeconds = this.timeRange / 1000;
      const timeOffsetSeconds = this.timeOffset / 1000;

      // Calculate UV parameters
      // uvOffsetX: what fraction of the texture to skip (based on timeOffset)
      const uvOffsetX = totalDurationSeconds > 0 ? timeOffsetSeconds / totalDurationSeconds : 0;

      // uvRangeX: what fraction of the texture to show (based on timeRange)
      const uvRangeX = totalDurationSeconds > 0 ? timeRangeSeconds / totalDurationSeconds : 1.0;

      // uvScaleX: scale to only show filled portion
      const uvScaleX = this.filledColumns > 0 ? this.filledColumns / this.TEXTURE_WIDTH : 1.0;

      const uniformData = new Float32Array([uvScaleX, uvOffsetX, uvRangeX, 0]);
      this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

      const commandEncoder = this.device.createCommandEncoder();
      const textureView = this.context.getCurrentTexture().createView();

      const passEncoder = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: textureView,
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.draw(6);
      passEncoder.end();

      this.device.queue.submit([commandEncoder.finish()]);
    } catch (error) {
      console.error("Render error:", error);
    }
  }

  destroy() {
    this.stopRendering();

    if (this.context) {
      this.context.unconfigure();
      this.context = null;
    }

    if (this.spectrogramTexture) {
      this.spectrogramTexture.destroy();
      this.spectrogramTexture = null;
    }

    this.pipeline = null;
    this.bindGroup = null;
  }

  isInitialized(): boolean {
    return this.context !== null && this.pipeline !== null && this.bindGroup !== null;
  }

  getTextureWidth(): number {
    return this.TEXTURE_WIDTH;
  }

  getTextureHeight(): number {
    return this.TEXTURE_HEIGHT;
  }

  /**
   * Set time axis parameters to control visible portion
   * @param timeRange Total time range to display (ms)
   * @param timeOffset Time offset from start (ms)
   * @param sampleRate Sample rate (Hz)
   * @param actualSampleCount Actual audio sample count (excluding padding)
   */
  setTimeAxis(timeRange: number, timeOffset: number, sampleRate: number, actualSampleCount?: number) {
    this.timeRange = timeRange;
    this.timeOffset = timeOffset;
    this.sampleRate = sampleRate;
    if (actualSampleCount !== undefined) {
      this.actualSampleCount = actualSampleCount;
    }

    // Trigger re-render with new time axis
    this.render();
  }
}
