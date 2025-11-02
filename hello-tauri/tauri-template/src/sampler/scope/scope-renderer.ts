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
  private frameCountsBuffer: GPUBuffer | null = null;
  private bufferMetadataBuffer: GPUBuffer | null = null;
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

    // Create uniform buffer for activeTextureCount
    this.uniformBuffer = this.device.createBuffer({
      label: "scope-renderer-uniforms",
      size: 16, // Single u32 with padding to 16 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create storage buffer for frame counts (more flexible than uniform for arrays)
    const transformer = this.analyzer.getTransformer();
    const maxBuffers = transformer.getConfig().outputBufferCount;
    this.frameCountsBuffer = this.device.createBuffer({
      label: "scope-renderer-frame-counts",
      size: maxBuffers * 4, // Array of u32
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Create storage buffer for buffer metadata (bytesPerRow for each buffer)
    this.bufferMetadataBuffer = this.device.createBuffer({
      label: "scope-renderer-buffer-metadata",
      size: maxBuffers * 4, // Array of u32
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
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
    const bufferCount = transformer.getConfig().outputBufferCount;
    console.log(`Creating pipeline with ${bufferCount} output buffers`);

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

    // Fragment shader - reads directly from output buffers and renders as spectrogram
    const fragmentShaderCode = `
      struct Uniforms {
        activeBufferCount: u32,
        numBins: u32,
        timeSliceCount: u32,
        readIndex: u32,  // Ring buffer read index (oldest buffer)
      };
      @group(0) @binding(0) var<uniform> uniforms: Uniforms;
      @group(0) @binding(1) var<storage, read> frameCountsPerBuffer: array<u32>;
      @group(0) @binding(2) var<storage, read> bytesPerRowPerBuffer: array<u32>;
      @group(0) @binding(3) var<storage, read> outputBuffer0: array<f32>;
      @group(0) @binding(4) var<storage, read> outputBuffer1: array<f32>;
      @group(0) @binding(5) var<storage, read> outputBuffer2: array<f32>;
      @group(0) @binding(6) var<storage, read> outputBuffer3: array<f32>;

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

      // Read a value from the appropriate buffer
      // Output buffer layout: output[frame * numBins + bin] (column-major)
      fn readFromBuffer(bufferIndex: u32, bin: u32, frame: u32) -> f32 {
        // Calculate the index in the buffer
        // Each row is aligned to 256 bytes, so we need to account for padding
        let bytesPerRow = bytesPerRowPerBuffer[bufferIndex];
        let floatsPerRow = bytesPerRow / 4u; // 4 bytes per f32
        let index = frame * floatsPerRow + bin;

        // Read from the appropriate buffer
        if (bufferIndex == 0u) {
          return outputBuffer0[index];
        } else if (bufferIndex == 1u) {
          return outputBuffer1[index];
        } else if (bufferIndex == 2u) {
          return outputBuffer2[index];
        } else if (bufferIndex == 3u) {
          return outputBuffer3[index];
        }
        return 0.0;
      }

      @fragment
      fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
        let displayCount = max(1u, uniforms.activeBufferCount);
        let ringSize = 4u; // Total number of buffers in ring (matches outputBufferCount)

        // Calculate total frames across all active buffers in chronological order
        var totalFrames = 0u;
        for (var i = 0u; i < displayCount; i = i + 1u) {
          // Map chronological index to physical buffer index
          let physicalIndex = (uniforms.readIndex + i) % ringSize;
          totalFrames = totalFrames + frameCountsPerBuffer[physicalIndex];
        }

        if (totalFrames == 0u) {
          return vec4<f32>(0.0, 0.0, 0.0, 1.0); // Black if no data
        }

        // Map UV to absolute frame position
        let absoluteFrame = uv.x * f32(totalFrames);

        // Find which buffer contains this frame (in chronological order)
        var frameOffset = 0u;
        var chronologicalIndex = 0u;
        var frameInBuffer = 0u;

        for (var i = 0u; i < displayCount; i = i + 1u) {
          // Map chronological index to physical buffer index
          let physicalIndex = (uniforms.readIndex + i) % ringSize;
          let framesInThisBuffer = frameCountsPerBuffer[physicalIndex];

          if (absoluteFrame < f32(frameOffset + framesInThisBuffer)) {
            chronologicalIndex = i;
            frameInBuffer = u32(absoluteFrame) - frameOffset;
            break;
          }
          frameOffset = frameOffset + framesInThisBuffer;
        }

        // Map chronological index to physical buffer index
        let bufferIndex = (uniforms.readIndex + chronologicalIndex) % ringSize;

        // Clamp to valid range
        let actualFrameCount = frameCountsPerBuffer[bufferIndex];
        frameInBuffer = min(frameInBuffer, actualFrameCount - 1u);

        // Vertical position maps to frequency (flipped)
        let tileV = 1.0 - uv.y;

        // Map to buffer coordinates
        let binIndex = clamp(u32(tileV * f32(uniforms.numBins)), 0u, uniforms.numBins - 1u);

        // Read from the buffer
        let value = readFromBuffer(bufferIndex, binIndex, frameInBuffer);

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
   * Create bind group with the output buffers from the transformer
   */
  private createBindGroup() {
    if (!this.pipeline || !this.uniformBuffer || !this.frameCountsBuffer || !this.bufferMetadataBuffer) return;

    const transformer = this.analyzer.getTransformer();
    const outputBufferRing = transformer.getOutputBufferRing();
    const bufferCount = transformer.getConfig().outputBufferCount;
    console.log(`Creating bind group with ${bufferCount} output buffers`);

    // Get references to all output buffers in the ring
    const outputBuffers: GPUBuffer[] = [];
    for (let i = 0; i < bufferCount; i++) {
      outputBuffers.push(outputBufferRing.getBuffer(i));
    }

    // Create the bind group with uniform buffer, metadata buffers, and output buffers
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.uniformBuffer,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: this.frameCountsBuffer,
          },
        },
        {
          binding: 2,
          resource: {
            buffer: this.bufferMetadataBuffer,
          },
        },
        {
          binding: 3,
          resource: {
            buffer: outputBuffers[0],
          },
        },
        {
          binding: 4,
          resource: {
            buffer: outputBuffers[1],
          },
        },
        {
          binding: 5,
          resource: {
            buffer: outputBuffers[2],
          },
        },
        {
          binding: 6,
          resource: {
            buffer: outputBuffers[3],
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
      // Update uniform buffer with current buffer count
      const transformer = this.analyzer.getTransformer();
      const outputRing = transformer.getOutputBufferRing();
      const activeCount = outputRing.getCount(); // Number of valid buffers currently in ring
      if (activeCount === 0) {
        // No data yet, skip rendering
        if (this.isRendering) {
          this.animationFrameId = requestAnimationFrame(this.renderFrame);
        }
        return;
      }
      const frameCounts = transformer.getOutputFrameCounts(); // Frame counts per buffer

      // Calculate bytesPerRow for each buffer (same for all buffers)
      const numBins = transformer.getWaveletTransform().getNumBins();
      const bytesPerRow = Math.ceil((numBins * Float32Array.BYTES_PER_ELEMENT) / 256) * 256;
      const bytesPerRowArray = new Uint32Array(transformer.getConfig().outputBufferCount);
      bytesPerRowArray.fill(bytesPerRow);

      // Update uniform buffer with active count, numBins, timeSliceCount, and readIndex
      const uniformData = new Uint32Array([
        activeCount,
        numBins,
        transformer.getConfig().timeSliceCount,
        outputRing.getReadIndex()  // Ring buffer read index (oldest data)
      ]);
      this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

      // Update storage buffer with frame counts
      this.device.queue.writeBuffer(this.frameCountsBuffer!, 0, frameCounts);

      // Update storage buffer with bytesPerRow metadata
      this.device.queue.writeBuffer(this.bufferMetadataBuffer!, 0, bytesPerRowArray);

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
      // Update uniform buffer with current buffer count
      const transformer = this.analyzer.getTransformer();
      const outputRing = transformer.getOutputBufferRing();
      const activeCount = outputRing.getCount(); // Number of valid buffers currently in ring
      if (activeCount === 0) {
        // No data yet, skip rendering
        return;
      }
      const frameCounts = transformer.getOutputFrameCounts();

      // Calculate bytesPerRow for each buffer
      const numBins = transformer.getWaveletTransform().getNumBins();
      const bytesPerRow = Math.ceil((numBins * Float32Array.BYTES_PER_ELEMENT) / 256) * 256;
      const bytesPerRowArray = new Uint32Array(transformer.getConfig().outputBufferCount);
      bytesPerRowArray.fill(bytesPerRow);

      // Update buffers
      const uniformData = new Uint32Array([
        activeCount,
        numBins,
        transformer.getConfig().timeSliceCount,
        outputRing.getReadIndex()  // Ring buffer read index (oldest data)
      ]);
      this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
      this.device.queue.writeBuffer(this.frameCountsBuffer!, 0, frameCounts);
      this.device.queue.writeBuffer(this.bufferMetadataBuffer!, 0, bytesPerRowArray);

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

    // Destroy buffers
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }
    if (this.frameCountsBuffer) {
      this.frameCountsBuffer.destroy();
      this.frameCountsBuffer = null;
    }
    if (this.bufferMetadataBuffer) {
      this.bufferMetadataBuffer.destroy();
      this.bufferMetadataBuffer = null;
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
