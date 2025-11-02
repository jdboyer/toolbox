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
  private format: GPUTextureFormat = "bgra8unorm";
  private animationFrameId: number | null = null;
  private isRendering = false;

  // Texture dimensions
  private readonly TEXTURE_WIDTH = 1024;  // Time axis (number of columns)
  private readonly TEXTURE_HEIGHT = 256;  // Frequency axis (number of bins)

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

    // Create pipeline and bind group
    await this.createPipeline();
    console.log("ScopeRenderer: Created pipeline");

    this.createBindGroup();
    console.log("ScopeRenderer: Created bind group");

    return true;
  }

  private async createPipeline() {
    // Vertex shader: full-screen quad
    const vertexShader = `
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
      };

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
          vec2<f32>(0.0, 1.0),
          vec2<f32>(1.0, 1.0),
          vec2<f32>(0.0, 0.0),
          vec2<f32>(0.0, 0.0),
          vec2<f32>(1.0, 1.0),
          vec2<f32>(1.0, 0.0),
        );

        var output: VertexOutput;
        output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
        output.uv = uv[vertexIndex];
        return output;
      }
    `;

    // Fragment shader: sample texture at UV
    const fragmentShader = `
      @group(0) @binding(0) var spectrogramTexture: texture_2d<f32>;
      @group(0) @binding(1) var spectrogramSampler: sampler;

      fn valueToColor(value: f32) -> vec3<f32> {
        let v = clamp(value * 10.0, 0.0, 1.0);

        // Hot colormap: black -> red -> yellow -> white
        if (v < 0.33) {
          let t = v / 0.33;
          return vec3<f32>(t, 0.0, 0.0);
        } else if (v < 0.67) {
          let t = (v - 0.33) / 0.34;
          return vec3<f32>(1.0, t, 0.0);
        } else {
          let t = (v - 0.67) / 0.33;
          return vec3<f32>(1.0, 1.0, t);
        }
      }

      @fragment
      fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
        // Sample texture (u=time, v=frequency)
        let sample = textureSample(spectrogramTexture, spectrogramSampler, uv);
        let magnitude = sample.r;

        // Convert to color
        let color = valueToColor(magnitude);
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
      console.error("Vertex shader compilation messages:", vertexInfo.messages);
    }

    const fragmentInfo = await fragmentModule.getCompilationInfo();
    if (fragmentInfo.messages.length > 0) {
      console.error("Fragment shader compilation messages:", fragmentInfo.messages);
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
    if (!this.pipeline || !this.spectrogramTexture) return;

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
    if (this.isRendering) {
      console.log("ScopeRenderer: Already rendering");
      return;
    }
    console.log("ScopeRenderer: Starting render loop");
    this.isRendering = true;
    this.renderFrame();
  }

  stopRendering() {
    this.isRendering = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private frameCount = 0;

  private renderFrame = () => {
    this.frameCount++;
    if (this.frameCount % 60 === 0) {
      console.log("ScopeRenderer: Rendering frame", this.frameCount);
    }

    if (!this.isRendering || !this.context || !this.pipeline || !this.bindGroup) {
      console.error("ScopeRenderer: Cannot render - missing:", {
        isRendering: this.isRendering,
        hasContext: !!this.context,
        hasPipeline: !!this.pipeline,
        hasBindGroup: !!this.bindGroup
      });
      return;
    }

    try {
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
    if (!this.context || !this.pipeline || !this.bindGroup) return;

    try {
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
}
