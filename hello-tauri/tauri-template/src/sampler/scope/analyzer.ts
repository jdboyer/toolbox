/**
 * Analyzer - Audio analysis engine using WebGPU
 *
 * This class provides audio analysis capabilities using WebGPU for acceleration.
 * It receives a pre-initialized WebGPU device and adapter at construction time
 * and uses them throughout its lifetime.
 *
 * The Analyzer is created and managed by the AnalyzerService singleton.
 */
export class Analyzer {
  private device: GPUDevice;
  private adapter: GPUAdapter;

  /**
   * Create an Analyzer instance
   * @param device Pre-initialized WebGPU device
   * @param adapter Pre-initialized WebGPU adapter
   */
  constructor(device: GPUDevice, adapter: GPUAdapter) {
    this.device = device;
    this.adapter = adapter;
  }

  /**
   * Get the WebGPU device
   */
  getDevice(): GPUDevice {
    return this.device;
  }

  /**
   * Get the WebGPU adapter
   */
  getAdapter(): GPUAdapter {
    return this.adapter;
  }

  /**
   * Get preferred canvas format
   */
  getPreferredCanvasFormat(): GPUTextureFormat {
    return navigator.gpu?.getPreferredCanvasFormat() || "bgra8unorm";
  }

  /**
   * Check if the device is ready for use
   */
  isReady(): boolean {
    return this.device !== null;
  }
}
