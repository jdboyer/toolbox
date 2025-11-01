import { useEffect, useRef } from "react";

interface ScopeViewProps {
  canvasWidth: number;
  canvasHeight?: number;
}

export function ScopeView({ canvasWidth, canvasHeight = 400 }: ScopeViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let animationFrameId: number;
    let device: GPUDevice | null = null;

    const initWebGPU = async () => {
      // Check if WebGPU is supported
      if (!navigator.gpu) {
        console.error("WebGPU is not supported in this browser");
        return;
      }

      // Get GPU adapter and device
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        console.error("Failed to get GPU adapter");
        return;
      }

      device = await adapter.requestDevice();
      const context = canvas.getContext("webgpu");
      if (!context) {
        console.error("Failed to get WebGPU context");
        return;
      }

      // Configure the canvas context
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({
        device,
        format,
        alphaMode: "opaque",
      });

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
      const vertexShaderModule = device.createShaderModule({
        code: vertexShaderCode,
      });

      const fragmentShaderModule = device.createShaderModule({
        code: fragmentShaderCode,
      });

      // Create render pipeline
      const pipeline = device.createRenderPipeline({
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
              format,
            },
          ],
        },
        primitive: {
          topology: "triangle-list",
        },
      });

      // Render function
      const render = () => {
        if (!device || !context) return;

        const commandEncoder = device.createCommandEncoder();
        const textureView = context.getCurrentTexture().createView();

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
        passEncoder.setPipeline(pipeline);
        passEncoder.draw(3); // Draw 3 vertices (triangle)
        passEncoder.end();

        device.queue.submit([commandEncoder.finish()]);

        // Request next frame
        animationFrameId = requestAnimationFrame(render);
      };

      // Start rendering
      render();
    };

    initWebGPU().catch(console.error);

    // Cleanup
    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      if (device) {
        device.destroy();
      }
    };
  }, [canvasWidth, canvasHeight]);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <canvas
        ref={canvasRef}
        width={canvasWidth}
        height={canvasHeight}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          imageRendering: "pixelated",
        }}
      />
    </div>
  );
}
