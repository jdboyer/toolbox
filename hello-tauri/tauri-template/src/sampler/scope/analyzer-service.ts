/**
 * AnalyzerService - Singleton service for managing the Analyzer instance
 *
 * This service is responsible for:
 * 1. Managing the WebGPU device and adapter lifecycle
 * 2. Creating and providing access to the singleton Analyzer instance
 * 3. Lazy initialization - creates the Analyzer only when first requested
 *
 * The Analyzer itself is unaware of this service and simply receives
 * the device/adapter at construction time.
 */

import { SimpleAnalyzer } from "./simple-analyzer";

class AnalyzerServiceImpl {
  private analyzer: SimpleAnalyzer | null = null;
  private device: GPUDevice | null = null;
  private adapter: GPUAdapter | null = null;
  private initializationPromise: Promise<SimpleAnalyzer | null> | null = null;

  /**
   * Get the singleton Analyzer instance
   * Creates the instance on first call (lazy initialization)
   */
  async getAnalyzer(): Promise<SimpleAnalyzer | null> {
    // If already initialized, return it
    if (this.analyzer) {
      return this.analyzer;
    }

    // If initialization is in progress, wait for it
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    // Start initialization
    this.initializationPromise = this.createAnalyzer();
    const analyzer = await this.initializationPromise;
    this.initializationPromise = null;
    return analyzer;
  }

  /**
   * Create the Analyzer instance with WebGPU device and adapter
   */
  private async createAnalyzer(): Promise<SimpleAnalyzer | null> {
    try {
      // Initialize WebGPU device and adapter
      await this.initializeWebGPU();

      if (!this.device || !this.adapter) {
        console.error("Failed to initialize WebGPU");
        return null;
      }

      // Create the SimpleAnalyzer instance (only needs device)
      this.analyzer = new SimpleAnalyzer(this.device);
      console.log("SimpleAnalyzer created successfully");
      return this.analyzer;
    } catch (error) {
      console.error("Failed to create SimpleAnalyzer:", error);
      return null;
    }
  }

  /**
   * Initialize WebGPU device and adapter
   */
  private async initializeWebGPU(): Promise<void> {
    // Check if WebGPU is supported
    if (!navigator.gpu) {
      throw new Error("WebGPU is not supported in this browser");
    }

    // Get GPU adapter
    this.adapter = await navigator.gpu.requestAdapter();
    if (!this.adapter) {
      throw new Error("Failed to get GPU adapter");
    }

    // Request device
    this.device = await this.adapter.requestDevice();

    // Set up device lost handler
    this.device.lost.then((info) => {
      console.error(`WebGPU device lost: ${info.message}`);
      this.device = null;
      this.adapter = null;
      this.analyzer = null;
    });

    console.log("WebGPU device initialized successfully");
  }

  /**
   * Cleanup - destroys the device and resets the service
   * Should only be called when the app is closing
   */
  destroy(): void {
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
    this.adapter = null;
    this.analyzer = null;
    console.log("AnalyzerService destroyed");
  }

  /**
   * Check if the Analyzer is ready
   */
  isReady(): boolean {
    return this.analyzer !== null && this.device !== null;
  }
}

// Export singleton instance
const AnalyzerService = new AnalyzerServiceImpl();
export default AnalyzerService;
