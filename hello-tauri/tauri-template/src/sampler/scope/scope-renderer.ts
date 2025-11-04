import type { Spectrogram } from "./spectrogram.ts";

/**
 * Uniform buffer data for UV scaling and offset
 */
interface UniformData {
  uvScale: [number, number];
  uvOffset: [number, number];
}

/**
 * ScopeRenderer - Displays Spectrogram texture
 *
 * Simple approach: Full-screen quad that renders the spectrogram texture
 * with UV scaling/offset controlled by a uniform buffer.
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
      console.error("ScopeRenderer: Failed to get WebGPU context");
      return false;
    }

    // Configure canvas
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
    });

    // Create uniform buffer (uvScale, uvOffset - 4 floats)
    this.createUniformBuffer();

    // Create pipeline
    this.createPipeline();

    // Create bind group
    this.createBindGroup();

    console.log("ScopeRenderer: Initialized");
    return true;
  }

  /**
   * Create uniform buffer for UV scaling and offset
   */
  private createUniformBuffer(): void {
    // Default: stretch whole texture across screen (scale=1.0, offset=0.0)
    const uniformData = new Float32Array([
      1.0, 1.0,  // uvScale (x, y)
      0.0, 0.0,  // uvOffset (x, y)
    ]);

    this.uniformBuffer = this.device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
  }

  private createPipeline() {
    // Vertex shader: full-screen quad with UV coordinates
    const vertexShader = `
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
      };

      @vertex
      fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
        // Two triangles forming a full-screen quad
        var pos = array<vec2<f32>, 6>(
          vec2<f32>(-1.0, -1.0),  // Bottom left
          vec2<f32>(1.0, -1.0),   // Bottom right
          vec2<f32>(-1.0, 1.0),   // Top left
          vec2<f32>(-1.0, 1.0),   // Top left
          vec2<f32>(1.0, -1.0),   // Bottom right
          vec2<f32>(1.0, 1.0),    // Top right
        );

        // UV coordinates (0,0) = top-left, (1,1) = bottom-right
        var uv = array<vec2<f32>, 6>(
          vec2<f32>(0.0, 1.0),  // Bottom left
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

    // Fragment shader: sample from spectrogram texture with UV scaling/offset
    const fragmentShader = `
      struct Uniforms {
        uvScale: vec2<f32>,
        uvOffset: vec2<f32>,
      };

      @group(0) @binding(0) var textureSampler: sampler;
      @group(0) @binding(1) var spectrogramTexture: texture_2d<f32>;
      @group(0) @binding(2) var<uniform> uniforms: Uniforms;

      @fragment
      fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
        // Apply UV scaling and offset
        let sampledUV = uv * uniforms.uvScale + uniforms.uvOffset;

        // Sample the spectrogram texture
        let color = textureSample(spectrogramTexture, textureSampler, sampledUV);

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
    if (!this.pipeline || !this.uniformBuffer) {
      console.warn("ScopeRenderer: Pipeline or uniform buffer not ready");
      return;
    }

    // Get texture from spectrogram
    try {
      const texture = this.spectrogram.getTexture();
      if (!texture) {
        console.warn("ScopeRenderer: Texture not yet created, skipping bind group creation");
        return;
      }

      // Create sampler
      const sampler = this.device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });

      // Create bind group with sampler, texture, and uniform buffer
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
          {
            binding: 2,
            resource: { buffer: this.uniformBuffer },
          },
        ],
      });

      console.log("ScopeRenderer: Bind group created successfully");
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

  /**
   * Update UV scale and offset
   * @param scale UV scale [x, y] - default [1.0, 1.0] stretches whole texture
   * @param offset UV offset [x, y] - default [0.0, 0.0] starts at origin
   */
  setUVTransform(scale: [number, number] = [1.0, 1.0], offset: [number, number] = [0.0, 0.0]) {
    if (!this.uniformBuffer) return;

    const uniformData = new Float32Array([
      scale[0], scale[1],
      offset[0], offset[1],
    ]);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
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

    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }

    this.pipeline = null;
    this.bindGroup = null;
  }

  isInitialized(): boolean {
    return this.context !== null && this.pipeline !== null && this.bindGroup !== null;
  }
}
