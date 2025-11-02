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

      // Convert value to color using a spectrogram-like palette
      fn valueToColor(value: f32) -> vec3<f32> {
        // Logarithmic scaling for better visualization
        let logValue = log2(max(abs(value), 0.00001));
        let scaled = clamp((logValue + 20.0) / 20.0, 0.0, 1.0);

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
        // DEBUG: Uncomment to test if shader is running
        // return vec4<f32>(uv.x, uv.y, 0.5, 1.0);

        // Show only the most recent 64 textures
        let displayCount = 64u;
        let totalCount = ${textureCount}u;

        let tileWidth = 1.0 / f32(displayCount);
        let tileIndex = u32(uv.x / tileWidth);

        // Just show the first 64 textures for now (simplify)
        let actualIndex = min(tileIndex, totalCount - 1u);

        let tileU = (uv.x - f32(tileIndex) * tileWidth) / tileWidth;
        let tileV = 1.0 - uv.y; // Flip vertically so low frequencies are at bottom

        // Get texture dimensions
        let texDims = textureDimensions(textureArray);
        let texCoord = vec2<i32>(
          clamp(i32(tileU * f32(texDims.x)), 0, i32(texDims.x) - 1),
          clamp(i32(tileV * f32(texDims.y)), 0, i32(texDims.y) - 1)
        );

        // Load from the texture array (no filtering)
        let value = textureLoad(textureArray, texCoord, actualIndex, 0).r;

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
    if (!this.pipeline) return;

    const transformer = this.analyzer.getTransformer();
    const textureArray = transformer.getTextureArray();
    const textureCount = transformer.getConfig().textureBufferCount;
    console.log(`Creating bind group with texture array (${textureCount} layers)`);

    // Create the bind group with just the texture array (no sampler needed for textureLoad)
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: textureArray.createView(),
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
    if (!this.isRendering || !this.context || !this.pipeline || !this.bindGroup) {
      return;
    }

    try {
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
    if (!this.context || !this.pipeline || !this.bindGroup) {
      return;
    }

    try {
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
