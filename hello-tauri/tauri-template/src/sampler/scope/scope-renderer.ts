import AnalyzerService from "./analyzer-service";

/**
 * ScopeRenderer - A reusable WebGPU renderer for scope visualization
 * Uses the shared WebGPU device managed by AnalyzerService
 */
export class ScopeRenderer {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private animationFrameId: number | null = null;
  private isRendering = false;

  /**
   * Initialize the WebGPU renderer with the given canvas
   */
  async initialize(canvas: HTMLCanvasElement): Promise<boolean> {
    // Get the Analyzer instance (creates it if needed)
    const analyzer = await AnalyzerService.getAnalyzer();
    if (!analyzer) {
      console.error("Failed to get Analyzer instance");
      return false;
    }

    // Get the device from the Analyzer
    this.device = analyzer.getDevice();

    // Get canvas context
    this.context = canvas.getContext("webgpu");
    if (!this.context) {
      console.error("Failed to get WebGPU context");
      return false;
    }

    // Configure the canvas context
    this.format = analyzer.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
    });

    // Create the render pipeline
    await this.createPipeline();

    return true;
  }

  /**
   * Create the render pipeline with shaders
   */
  private async createPipeline() {
    if (!this.device) return;

    // Vertex shader - defines triangle vertices in clip space
    const vertexShaderCode = `
      @vertex
      fn main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
        var pos = array<vec2<f32>, 3>(
          vec2<f32>(0.0, 0.5),   // Top vertex
          vec2<f32>(-0.5, -0.5), // Bottom left
          vec2<f32>(0.5, -0.5)   // Bottom right
        );
        return vec4<f32>(pos[vertexIndex], 0.0, 1.0);
      }
    `;

    // Fragment shader - colors the triangle
    const fragmentShaderCode = `
      @fragment
      fn main() -> @location(0) vec4<f32> {
        return vec4<f32>(1.0, 0.5, 0.2, 1.0); // Orange color
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
    if (!this.isRendering || !this.device || !this.context || !this.pipeline) {
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
      passEncoder.draw(3); // Draw 3 vertices (triangle)
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
   * Clean up renderer resources
   * Note: Does NOT destroy the shared device - that's managed by analyzer.ts
   */
  destroy() {
    this.stopRendering();

    // Unconfigure context
    if (this.context) {
      this.context.unconfigure();
      this.context = null;
    }

    // Clear references but don't destroy the shared device
    this.device = null;
    this.pipeline = null;
  }

  /**
   * Check if the renderer is initialized
   */
  isInitialized(): boolean {
    return this.device !== null && this.context !== null && this.pipeline !== null;
  }
}
