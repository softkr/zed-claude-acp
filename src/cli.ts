#!/usr/bin/env node

/**
 * Zed Claude ACP Server - CLI Entry Point
 * 
 * This is the command-line entry point for the Zed Claude ACP Server.
 * It imports and executes the main application logic from index.ts.
 * 
 * Features:
 * - Proper error handling with exit codes
 * - Clean error messaging to stderr only
 * - Node.js shebang for direct execution
 * - Strict stdout discipline for ACP protocol
 */

import { startServer } from "./index.js";

/**
 * Main CLI execution function
 * Starts the ACP server and handles any unhandled errors
 */
async function run(): Promise<void> {
  try {
    await startServer();
  } catch (error) {
    // Log the error to stderr without corrupting stdout protocol
    const errorMessage = error instanceof Error 
      ? error.message 
      : String(error);
    
    console.error(`[CLI][FATAL] Failed to start Zed Claude ACP Server: ${errorMessage}`);
    
    // Log stack trace in debug mode
    if (process.env.ACP_DEBUG === "true" && error instanceof Error && error.stack) {
      console.error("[CLI][DEBUG] Stack trace:", error.stack);
    }
    
    // Exit with error code
    process.exit(1);
  }
}

// Check Node.js version
const nodeVersion = process.versions.node;
const majorVersion = parseInt(nodeVersion.split('.')[0], 10);

if (majorVersion < 18) {
  console.error(`[CLI][FATAL] Node.js version 18 or higher is required. Current version: ${nodeVersion}`);
  process.exit(1);
}

// Execute the CLI
run();
