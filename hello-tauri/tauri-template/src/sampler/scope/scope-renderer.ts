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

    // Fragment shader - samples from textures and renders them as tiles
    const fragmentShaderCode = `
      @group(0) @binding(0) var textureSampler: sampler;
      ${Array.from({ length: textureCount }, (_, i) =>
        `@group(0) @binding(${i + 1}) var texture${i}: texture_2d<f32>;`
      ).join('\n      ')}

      @fragment
      fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
        let textureCount = ${textureCount};
        let tileWidth = 1.0 / f32(textureCount);
        let tileIndex = u32(uv.x / tileWidth);
        let tileU = (uv.x - f32(tileIndex) * tileWidth) / tileWidth;
        let tileV = uv.y;
        let tileUV = vec2<f32>(tileU, tileV);

        var color = vec4<f32>(0.0, 0.0, 0.0, 1.0);

        ${Array.from({ length: textureCount }, (_, i) =>
          `if (tileIndex == ${i}u) {
          let value = textureSample(texture${i}, textureSampler, tileUV).r;
          color = vec4<f32>(value, value, value, 1.0);
        }`
        ).join(' else ')}

        return color;
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
   * Create bind group with all textures from the transformer
   */
  private createBindGroup() {
    if (!this.pipeline) return;

    const transformer = this.analyzer.getTransformer();
    const textureRing = transformer.getTextureBufferRing();
    const textureCount = transformer.getConfig().textureBufferCount;

    // Create a sampler
    const sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // Build bind group entries: sampler + all textures
    const entries: GPUBindGroupEntry[] = [
      {
        binding: 0,
        resource: sampler,
      },
    ];

    // Add all textures from the ring buffer
    for (let i = 0; i < textureCount; i++) {
      const texture = textureRing.getBuffer(i);
      entries.push({
        binding: i + 1,
        resource: texture.createView(),
      });
    }

    // Create the bind group
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: entries,
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
