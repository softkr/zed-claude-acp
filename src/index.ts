/**
 * Zed Claude ACP Server - Main Application
 * 
 * Sets up the ACP bridge between Claude Code SDK and Zed's External Agent protocol.
 * Handles process management, stream conversion, and connection lifecycle.
 */

import { AgentSideConnection } from "@zed-industries/agent-client-protocol";
import { ZedClaudeAgent } from "./agent.js";
import { Writable, Readable } from "node:stream";
import { WritableStream, ReadableStream } from "node:stream/web";

/**
 * Logger utility for stderr-only logging
 */
class BridgeLogger {
  private readonly isDebugEnabled: boolean;

  constructor() {
    this.isDebugEnabled = process.env.ACP_DEBUG === "true";
  }

  /**
   * Log with level and timestamp
   */
  private log(level: string, message: string, data?: unknown): void {
    if (this.isDebugEnabled || level === "FATAL") {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}][Bridge][${level}] ${message}`;
      
      console.error(logMessage);
      if (data !== undefined) {
        console.error(JSON.stringify(data, null, 2));
      }
    }
  }

  info(message: string, data?: unknown): void {
    this.log("INFO", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log("WARN", message, data);
  }

  error(message: string, data?: unknown): void {
    this.log("ERROR", message, data);
  }

  /**
   * Fatal errors always log regardless of debug mode
   */
  fatal(message: string, error?: unknown): void {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}][Bridge][FATAL] ${message}`);
    
    if (error) {
      if (error instanceof Error && error.stack) {
        console.error("Stack trace:", error.stack);
      } else {
        console.error("Error details:", JSON.stringify(error, null, 2));
      }
    }
  }
}

// Initialize logger
const logger = new BridgeLogger();

/**
 * Set up process-level handlers for graceful shutdown and error handling
 */
function setupProcessHandlers(): void {
  // Handle graceful shutdown
  const handleShutdown = (signal: string) => {
    logger.info(`Received ${signal}, initiating graceful shutdown...`);
    process.exit(0);
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));

  // Handle uncaught exceptions
  process.on("uncaughtException", (error: Error) => {
    logger.fatal("Uncaught exception occurred", error);
    process.exit(1);
  });

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
    logger.fatal("Unhandled promise rejection", {
      reason,
      promise: String(promise),
    });
    process.exit(1);
  });

  // Prevent accidental stdout writes
  console.log = (...args: unknown[]) => {
    logger.warn("Intercepted console.log call (stdout is reserved for ACP protocol)", args);
    // In case we need to debug something critical, still allow stderr output
    if (process.env.ACP_ALLOW_CONSOLE_LOG === "true") {
      console.error("[CONSOLE.LOG]", ...args);
    }
  };

  logger.info("Process handlers configured successfully");
}

/**
 * Create Web Streams from Node.js stdio for ACP communication
 */
function createACPStreams(): {
  inputStream: ReadableStream<Uint8Array>;
  outputStream: WritableStream<Uint8Array>;
} {
  logger.info("Converting Node.js streams to Web Streams for ACP protocol");

  // Convert Node.js stdin to Web ReadableStream
  const inputStream = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  
  // Convert Node.js stdout to Web WritableStream
  const outputStream = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;

  logger.info("Stream conversion completed", {
    hasInputStream: !!inputStream,
    hasOutputStream: !!outputStream,
  });

  return { inputStream, outputStream };
}

/**
 * Create and configure the ACP Agent connection
 */
function createACPConnection(
  inputStream: ReadableStream<Uint8Array>,
  outputStream: WritableStream<Uint8Array>
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      logger.info("Initializing ACP Agent connection...");

      // Create the agent-side connection
      new AgentSideConnection(
        // Agent factory function
        (client) => {
          logger.info("Creating new ZedClaudeAgent instance");
          return new ZedClaudeAgent(client);
        },
        outputStream, // WritableStream for sending to client (stdout)
        inputStream   // ReadableStream for receiving from client (stdin)
      );

      logger.info("ACP Agent connection established successfully");
      
      // Keep stdin open to maintain connection
      process.stdin.resume();
      
      resolve();
    } catch (error) {
      logger.fatal("Failed to create ACP connection", error);
      reject(error);
    }
  });
}

/**
 * Main application startup function
 */
export async function startServer(): Promise<void> {
  logger.info("Starting Zed Claude ACP Server...", {
    nodeVersion: process.version,
    debugMode: process.env.ACP_DEBUG === "true",
    permissionMode: process.env.ACP_PERMISSION_MODE || "default",
    platform: process.platform,
    arch: process.arch,
  });

  try {
    // Set up process-level error handling
    setupProcessHandlers();
    
    // Create ACP communication streams
    const { inputStream, outputStream } = createACPStreams();
    
    // Initialize ACP connection
    await createACPConnection(inputStream, outputStream);
    
    logger.info("🚀 Zed Claude ACP Server is running and ready to accept connections");
    
    // The process will continue running until terminated
    
  } catch (error) {
    logger.fatal("Failed to start ACP server", error);
    throw error; // Re-throw to let CLI handle it
  }
}

// Export the agent for external use
export { ZedClaudeAgent } from "./agent.js";

// Legacy export for backward compatibility
export const main = startServer;
