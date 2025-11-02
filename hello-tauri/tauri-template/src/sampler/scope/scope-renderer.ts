import type { Analyzer } from "./analyzer";

/**
 * ScopeRenderer - A WebGPU renderer for scope visualization
 * Renders all textures from the Transformer's texture ring buffer as a row of tiles
 */
export class ScopeRenderer {
  private device: GPUDevice;
  private analyzer: Analyzer;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private animationFrameId: number | null = null;
  private isRendering = false;

  /**
   * Create a ScopeRenderer instance
   * @param device WebGPU device
   * @param analyzer Analyzer instance to get textures from
   */
  constructor(device: GPUDevice, analyzer: Analyzer) {
    this.device = device;
    this.analyzer = analyzer;
    this.format = navigator.gpu?.getPreferredCanvasFormat() || "bgra8unorm";
  }

  /**
   * Initialize the WebGPU renderer with the given canvas
   */
  async initialize(canvas: HTMLCanvasElement): Promise<boolean> {
    // Get canvas context
    this.context = canvas.getContext("webgpu");
    if (!this.context) {
      console.error("Failed to get WebGPU context");
      return false;
    }

    // Configure the canvas context
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
    });

    // Create uniform buffer for dynamic parameters
    this.uniformBuffer = this.device.createBuffer({
      label: "scope-renderer-uniforms",
      size: 16, // 4 bytes for u32 (textureCount) + 12 bytes padding
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create the render pipeline and bind group
    await this.createPipeline();
    this.createBindGroup();

    return true;
  }

  /**
   * Create the render pipeline with shaders
   */
  private async createPipeline() {
    const transformer = this.analyzer.getTransformer();
    const textureCount = transformer.getConfig().textureBufferCount;
    console.log(`Creating pipeline with ${textureCount} textures`);

    // Vertex shader - outputs full-screen quad with UV coordinates
    const vertexShaderCode = `
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
      };

      @vertex
      fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
        var pos = array<vec2<f32>, 6>(
          vec2<f32>(-1.0, -1.0),  // Bottom left
          vec2<f32>(1.0, -1.0),   // Bottom right
          vec2<f32>(-1.0, 1.0),   // Top left
          vec2<f32>(-1.0, 1.0),   // Top left
          vec2<f32>(1.0, -1.0),   // Bottom right
          vec2<f32>(1.0, 1.0),    // Top right
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

    // Fragment shader - loads from texture array and renders as spectrogram
    // Note: Using textureLoad instead of textureSample because r32float is unfilterable
    const fragmentShaderCode = `
      @group(0) @binding(0) var textureArray: texture_2d_array<f32>;

      struct Uniforms {
        activeTextureCount: u32,
      };
      @group(0) @binding(1) var<uniform> uniforms: Uniforms;

      // Convert value to color using a spectrogram-like palette
      fn valueToColor(value: f32) -> vec3<f32> {
        // More aggressive scaling to see the data better
        let absValue = abs(value);

        // Linear scaling with adjustable range
        let scaled = clamp(absValue * 50.0, 0.0, 1.0);

        // Hot colormap: black -> red -> yellow -> white
        if (scaled < 0.33) {
          let t = scaled / 0.33;
          return vec3<f32>(t, 0.0, 0.0);
        } else if (scaled < 0.67) {
          let t = (scaled - 0.33) / 0.34;
          return vec3<f32>(1.0, t, 0.0);
        } else {
          let t = (scaled - 0.67) / 0.33;
          return vec3<f32>(1.0, 1.0, t);
        }
      }

      @fragment
      fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
        // Each texture is displayed as a vertical tile
        // uv.x (0-1) = horizontal position across all tiles
        // uv.y (0-1) = vertical position (same for all tiles)

        let totalCount = ${textureCount}u;
        let displayCount = max(1u, uniforms.activeTextureCount);  // Show only populated tiles
        let tileWidth = 1.0 / f32(displayCount);

        // Which tile are we in?
        let tileIndex = u32(uv.x / tileWidth);

        // Position within this tile (0-1)
        let tileU = (uv.x - f32(tileIndex) * tileWidth) / tileWidth;
        let tileV = 1.0 - uv.y; // Flip vertically so low frequencies are at bottom

        // Border width (in UV space)
        let borderWidth = 0.01;

        // Check if we're in the border region
        if (tileU < borderWidth || tileU > 1.0 - borderWidth) {
          return vec4<f32>(0.3, 0.3, 0.3, 1.0); // Gray border
        }

        // If we're beyond the tiles with data, show black
        if (tileIndex >= displayCount) {
          return vec4<f32>(0.0, 0.0, 0.0, 1.0);
        }

        // Get texture dimensions
        // Texture layout: width=numBins (frequency), height=numFrames (time)
        let texDims = textureDimensions(textureArray);

        // Map tile UV to texture coordinates
        // Buffer is column-major: output[frame * numBins + bin]
        // Each row in the texture = one bin across all frames
        let texCoord = vec2<i32>(
          clamp(i32(tileV * f32(texDims.x)), 0, i32(texDims.x) - 1),  // Frequency bin (X in texture)
          clamp(i32(tileU * f32(texDims.y)), 0, i32(texDims.y) - 1)   // Time frame (Y in texture)
        );

        // Load from the texture array
        let value = textureLoad(textureArray, texCoord, tileIndex, 0).r;

        // Convert to color
        let color = valueToColor(value);

        return vec4<f32>(color, 1.0);
      }
    `;

    // Create shader modules
    const vertexShaderModule = this.device.createShaderModule({
      code: vertexShaderCode,
    });

    const fragmentShaderModule = this.device.createShaderModule({
      code: fragmentShaderCode,
    });

    // Create render pipeline
    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: vertexShaderModule,
        entryPoint: "main",
      },
      fragment: {
        module: fragmentShaderModule,
        entryPoint: "main",
        targets: [
          {
            format: this.format,
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  /**
   * Create bind group with the texture array from the transformer
   */
  private createBindGroup() {
    if (!this.pipeline || !this.uniformBuffer) return;

    const transformer = this.analyzer.getTransformer();
    const textureArray = transformer.getTextureArray();
    const textureCount = transformer.getConfig().textureBufferCount;
    console.log(`Creating bind group with texture array (${textureCount} layers)`);

    // Create the bind group with texture array and uniform buffer
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: textureArray.createView(),
        },
        {
          binding: 1,
          resource: {
            buffer: this.uniformBuffer,
          },
        },
      ],
    });
  }

  /**
   * Start the render loop
   */
  startRendering() {
    if (this.isRendering) return;
    this.isRendering = true;
    this.renderFrame();
  }

  /**
   * Stop the render loop
   */
  stopRendering() {
    this.isRendering = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Render a single frame
   */
  private renderFrame = () => {
    if (!this.isRendering || !this.context || !this.pipeline || !this.bindGroup || !this.uniformBuffer) {
      return;
    }

    try {
      // Update uniform buffer with current write index
      const transformer = this.analyzer.getTransformer();
      const writeIndex = transformer.getTextureBufferRing().getWriteIndex();
      const activeCount = Math.max(1, writeIndex); // At least show 1 tile

      const uniformData = new Uint32Array([activeCount]);
      this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

      const commandEncoder = this.device.createCommandEncoder();
      const currentTexture = this.context.getCurrentTexture();
      const textureView = currentTexture.createView();

      const renderPassDescriptor: GPURenderPassDescriptor = {
        colorAttachments: [
          {
            view: textureView,
            clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 }, // Dark gray background
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      };

      const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.draw(6); // Draw 6 vertices (2 triangles = full-screen quad)
      passEncoder.end();

      this.device.queue.submit([commandEncoder.finish()]);
    } catch (error) {
      console.error("WebGPU render error:", error);
      this.stopRendering();
      return;
    }

    // Request next frame
    if (this.isRendering) {
      this.animationFrameId = requestAnimationFrame(this.renderFrame);
    }
  };

  /**
   * Manually trigger a single render (useful for manual rendering mode)
   */
  render() {
    if (!this.context || !this.pipeline || !this.bindGroup || !this.uniformBuffer) {
      return;
    }

    try {
      // Update uniform buffer with current write index
      const transformer = this.analyzer.getTransformer();
      const writeIndex = transformer.getTextureBufferRing().getWriteIndex();
      const activeCount = Math.max(1, writeIndex);

      const uniformData = new Uint32Array([activeCount]);
      this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

      const commandEncoder = this.device.createCommandEncoder();
      const currentTexture = this.context.getCurrentTexture();
      const textureView = currentTexture.createView();

      const renderPassDescriptor: GPURenderPassDescriptor = {
        colorAttachments: [
          {
            view: textureView,
            clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      };

      const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.draw(6);
      passEncoder.end();

      this.device.queue.submit([commandEncoder.finish()]);
    } catch (error) {
      console.error("WebGPU render error:", error);
    }
  }

  /**
   * Clean up renderer resources
   */
  destroy() {
    this.stopRendering();

    // Unconfigure context
    if (this.context) {
      this.context.unconfigure();
      this.context = null;
    }

    // Destroy uniform buffer
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }

    // Clear references
    this.pipeline = null;
    this.bindGroup = null;
  }

  /**
   * Check if the renderer is initialized
   */
  isInitialized(): boolean {
    return this.context !== null && this.pipeline !== null && this.bindGroup !== null;
  }
}
