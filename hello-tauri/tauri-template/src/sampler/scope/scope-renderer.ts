import type { Spectrogram } from "./spectrogram.ts";

/**
 * ScopeRenderer - Displays Spectrogram textures in real-time
 *
 * Simple approach: One full-screen quad that samples from a texture array
 * based on UV coordinates to display all textures side-by-side.
 */
export class ScopeRenderer {
  private device: GPUDevice;
  private spectrogram: Spectrogram;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private format: GPUTextureFormat = "bgra8unorm";

  constructor(device: GPUDevice, spectrogram: Spectrogram) {
    this.device = device;
    this.spectrogram = spectrogram;
    this.format = navigator.gpu?.getPreferredCanvasFormat() || "bgra8unorm";
  }

  initialize(canvas: HTMLCanvasElement): boolean {
    console.log("ScopeRenderer: Initializing");

    // Get canvas context
    this.context = canvas.getContext("webgpu");
    if (!this.context) {
      console.error("Failed to get WebGPU context");
      return false;
    }

    // Configure canvas
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
    });

    // Create pipeline and bind group
    this.createPipeline();
    this.createBindGroup();

    console.log("ScopeRenderer: Initialized");
    return true;
  }

  private createPipeline() {
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
          vec2<f32>(0.0, 1.0),  // Bottom left (flip Y so low freq at bottom)
          vec2<f32>(1.0, 1.0),  // Bottom right
          vec2<f32>(0.0, 0.0),  // Top left
          vec2<f32>(0.0, 0.0),  // Top left
          vec2<f32>(1.0, 1.0),  // Bottom right
          vec2<f32>(1.0, 0.0),  // Top right
        );

        var output: VertexOutput;
        output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
        output.uv = uv[vertexIndex];
        return output;
      }
    `;

    // Fragment shader: sample from a large 2D texture
    const fragmentShader = `
      @group(0) @binding(0) var textureSampler: sampler;
      @group(0) @binding(1) var spectrogramTexture: texture_2d<f32>;

      @fragment
      fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
        // EXACTLY match how transformer_sine_sweep.png is generated:
        // 1. Map canvas 0-1 directly to texture 0-1 (show full texture width)
        // 2. Y is already flipped in vertex shader (uv.y 0=top, 1=bottom in texture space)

        let textureUV = vec2<f32>(uv.x, uv.y);

        // Sample the texture directly
        let color = textureSample(spectrogramTexture, textureSampler, textureUV);

        return color;
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
    if (!this.pipeline) return;

    // Check if texture exists (it's created in configure())
    try {
      const texture = this.spectrogram.getTextureArray();
      if (!texture) {
        console.warn("ScopeRenderer: Texture not yet created, skipping bind group creation");
        return;
      }

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
            resource: sampler,
          },
          {
            binding: 1,
            resource: texture.createView(),
          },
        ],
      });
    } catch (e) {
      console.warn("ScopeRenderer: Failed to create bind group, texture may not be ready yet", e);
    }
  }

  /**
   * Recreate bind group (call after spectrogram texture is recreated)
   */
  recreateBindGroup() {
    this.createBindGroup();
  }

  private frameCount = 0;

  render() {
    if (!this.context || !this.pipeline || !this.bindGroup) return;

    try {
      this.frameCount++;

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
    if (this.context) {
      this.context.unconfigure();
      this.context = null;
    }

    this.pipeline = null;
    this.bindGroup = null;
  }

  isInitialized(): boolean {
    return this.context !== null && this.pipeline !== null && this.bindGroup !== null;
  }
}
