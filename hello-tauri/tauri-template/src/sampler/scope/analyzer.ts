/**
 * Analyzer - Singleton WebGPU device manager
 *
 * This module manages a single shared WebGPU device for the entire application.
 * All WebGPU operations (scope rendering, CQT computation, etc.) should use
 * this shared device to avoid device conflicts and resource issues.
 */

class WebGPUDeviceManager {
  private static instance: WebGPUDeviceManager | null = null;
  private device: GPUDevice | null = null;
  private adapter: GPUAdapter | null = null;
  private initPromise: Promise<boolean> | null = null;
  private isInitialized = false;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): WebGPUDeviceManager {
    if (!WebGPUDeviceManager.instance) {
      WebGPUDeviceManager.instance = new WebGPUDeviceManager();
    }
    return WebGPUDeviceManager.instance;
  }

  /**
   * Initialize the WebGPU device (or return existing initialization promise)
   */
  async initialize(): Promise<boolean> {
    // If already initialized, return true
    if (this.isInitialized && this.device) {
      return true;
    }

    // If initialization is in progress, return the existing promise
    if (this.initPromise) {
      return this.initPromise;
    }

    // Start new initialization
    this.initPromise = this.initializeDevice();
    const result = await this.initPromise;
    this.initPromise = null;
    return result;
  }

  /**
   * Internal device initialization
   */
  private async initializeDevice(): Promise<boolean> {
    try {
      // Check if WebGPU is supported
      if (!navigator.gpu) {
        console.error("WebGPU is not supported in this browser");
        return false;
      }

      // Get GPU adapter
      this.adapter = await navigator.gpu.requestAdapter();
      if (!this.adapter) {
        console.error("Failed to get GPU adapter");
        return false;
      }

      // Request device
      this.device = await this.adapter.requestDevice();

      // Set up device lost handler
      this.device.lost.then((info) => {
        console.error(`WebGPU device lost: ${info.message}`);
        this.isInitialized = false;
        this.device = null;
        this.adapter = null;
      });

      this.isInitialized = true;
      console.log("WebGPU device initialized successfully");
      return true;
    } catch (error) {
      console.error("Failed to initialize WebGPU device:", error);
      this.isInitialized = false;
      this.device = null;
      this.adapter = null;
      return false;
    }
  }

  /**
   * Get the shared GPU device (initializes if needed)
   */
  async getDevice(): Promise<GPUDevice | null> {
    if (!this.isInitialized || !this.device) {
      const success = await this.initialize();
      if (!success) {
        return null;
      }
    }
    return this.device;
  }

  /**
   * Get the GPU adapter
   */
  getAdapter(): GPUAdapter | null {
    return this.adapter;
  }

  /**
   * Check if the device is initialized and ready
   */
  isReady(): boolean {
    return this.isInitialized && this.device !== null;
  }

  /**
   * Get preferred canvas format
   */
  getPreferredCanvasFormat(): GPUTextureFormat {
    return navigator.gpu?.getPreferredCanvasFormat() || "bgra8unorm";
  }

  /**
   * Cleanup - should only be called when the app is closing
   * DO NOT call this during normal operation!
   */
  destroy() {
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
    this.adapter = null;
    this.isInitialized = false;
    console.log("WebGPU device destroyed");
  }
}

// Export singleton instance getter
export const getGPUDevice = async (): Promise<GPUDevice | null> => {
  const manager = WebGPUDeviceManager.getInstance();
  return manager.getDevice();
};

export const getGPUAdapter = (): GPUAdapter | null => {
  const manager = WebGPUDeviceManager.getInstance();
  return manager.getAdapter();
};

export const isGPUReady = (): boolean => {
  const manager = WebGPUDeviceManager.getInstance();
  return manager.isReady();
};

export const getPreferredCanvasFormat = (): GPUTextureFormat => {
  const manager = WebGPUDeviceManager.getInstance();
  return manager.getPreferredCanvasFormat();
};

export const destroyGPUDevice = () => {
  const manager = WebGPUDeviceManager.getInstance();
  manager.destroy();
};

// Initialize device on module load (optional - can remove if you prefer lazy init)
// This ensures the device is ready early in the app lifecycle
if (typeof window !== "undefined") {
  WebGPUDeviceManager.getInstance().initialize().catch(console.error);
}
