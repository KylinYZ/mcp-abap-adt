import type { ToolDefinition } from "../types/tools";
import type { ADTClient } from "../adt/index.js";
import { performance } from 'perf_hooks';
import { createLogger } from '../lib/logger';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export abstract class BaseHandler {
  protected readonly adtclient: ADTClient;
  protected readonly logger = createLogger(this.constructor.name);
  private readonly metrics = {
    requestCount: 0,
    errorCount: 0,
    successCount: 0,
    totalTime: 0
  };

  constructor(adtclient: ADTClient) {
    this.adtclient = adtclient;
  }

  protected trackRequest(startTime: number, success: boolean): void {
    const duration = performance.now() - startTime;
    this.metrics.requestCount++;
    this.metrics.totalTime += duration;
    
    if (success) {
      this.metrics.successCount++;
    } else {
      this.metrics.errorCount++;
    }

    this.logger.info('Request completed', {
      duration,
      success,
      metrics: this.getMetrics()
    });
  }

  protected getMetrics() {
    return {
      ...this.metrics,
      averageTime: this.metrics.requestCount > 0 
        ? this.metrics.totalTime / this.metrics.requestCount 
        : 0
    };
  }

  protected async executeClientCall(action: string, operation: () => Promise<unknown>): Promise<Record<string, unknown>> {
    const startTime = performance.now();
    try {
      const result = await operation();
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'success', result })
        }]
      };
    } catch {
      this.trackRequest(startTime, false);
      // Raw ADT errors can contain headers or target details; expose neither.
      throw new McpError(ErrorCode.InternalError, `${action} failed.`);
    }
  }

  abstract getTools(): ToolDefinition[];
}
