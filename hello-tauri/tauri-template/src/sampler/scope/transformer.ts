import type { Accumulator } from "./accumulator";

/**
 * Configuration options for the Transformer
 */
export interface TransformerConfig {
  /** Dummy option for future use */
  placeholder: boolean;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: TransformerConfig = {
  placeholder: true,
};

/**
 * Transformer - Processes audio blocks from the Accumulator
 *
 * The Transformer receives a reference to the Accumulator and processes
 * filled blocks in order, marking them as processed when complete.
 */
export class Transformer {
  private accumulator: Accumulator;
  private config: TransformerConfig;

  /**
   * Create a Transformer instance
   * @param accumulator Reference to the Accumulator instance
   */
  constructor(accumulator: Accumulator) {
    this.accumulator = accumulator;
    this.config = { ...DEFAULT_CONFIG };
  }

  /**
   * Configure the transformer
   * @param config Partial configuration object (only specified fields will be updated)
   */
  configureTransformer(config: Partial<TransformerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Process blocks from the accumulator
   * This method is called after new samples are added to the accumulator
   */
  processBlocks(): void {
    // TODO: Implement block processing logic
    // For now, we'll just mark all blocks as processed
    this.accumulator.markProcessed();
  }

  /**
   * Get the current configuration
   */
  getConfig(): TransformerConfig {
    return { ...this.config };
  }
}
