/**
 * Zed Claude ACP Server - Type Definitions
 * 
 * Core type definitions and helper functions for the ACP server.
 * This file has no external dependencies to keep it lightweight.
 */

// Permission modes for Claude Code SDK
export type PermissionModeType = 
  | "default"           // Ask for permission on all operations
  | "acceptEdits"       // Auto-accept file edits only
  | "bypassPermissions" // Bypass all permission checks
  | "plan";             // Planning mode

// Session state structure
export interface SessionState {
  pendingPrompt: AsyncIterableIterator<any> | null;
  abortController: AbortController | null;
  claudeSessionId?: string;
  permissionMode: PermissionModeType;
  messageCount: number;
  createdAt: Date;
  lastActiveAt: Date;
}

// Claude message content blocks
export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

// Claude message structure
export interface ClaudeMessageStructure {
  role?: "user" | "assistant" | "system";
  content?: ContentBlock[];
}

// Claude SDK message types
export interface ClaudeMessage {
  type: string;
  text?: string;
  id?: string;
  tool_name?: string;
  input?: unknown;
  output?: string;
  error?: string;
  event?: ClaudeStreamEvent;
  message?: ClaudeMessageStructure;
  result?: string;
  session_id?: string;
}

// Streaming event from Claude
export interface ClaudeStreamEvent {
  type: string;
  content_block?: {
    type: string;
    text?: string;
  };
  delta?: {
    type: string;
    text?: string;
  };
}

// Tool call status for ACP
export type ToolCallStatus = "pending" | "completed" | "failed";

// ACP tool kinds
export type ACPToolKind = 
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

// Session statistics
export interface SessionStats {
  createdAt: Date;
  lastActiveAt: Date;
  messageCount: number;
  permissionMode: PermissionModeType;
  hasClaudeSession: boolean;
}

// Helper: Validate permission mode
export function isValidPermissionMode(mode: unknown): mode is PermissionModeType {
  const validModes: PermissionModeType[] = [
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan"
  ];
  return typeof mode === "string" && validModes.includes(mode as PermissionModeType);
}

// Helper: Extract text from prompt blocks
export function extractTextBlocks(promptBlocks: Array<{ type: string; text?: string }>): string {
  return promptBlocks
    .filter((block): block is { type: "text"; text: string } =>
      block.type === "text" && typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("");
}

// Helper: Create default session stats
export function createDefaultSessionStats(
  permissionMode: PermissionModeType = "default"
): SessionStats {
  const now = new Date();
  return {
    createdAt: now,
    lastActiveAt: now,
    messageCount: 0,
    permissionMode,
    hasClaudeSession: false,
  };
}

// Helper: Parse environment permission mode
export function parsePermissionMode(mode?: string): PermissionModeType {
  if (mode && isValidPermissionMode(mode)) {
    return mode;
  }
  return "default";
}

// Helper: Map tool name to ACP tool kind
export function mapToolKind(toolName: string): ACPToolKind {
  const lowerName = toolName.toLowerCase();

  if (lowerName.includes("read") || lowerName.includes("view") || lowerName.includes("get")) {
    return "read";
  }
  
  if (lowerName.includes("write") || lowerName.includes("create") || 
      lowerName.includes("update") || lowerName.includes("edit")) {
    return "edit";
  }
  
  if (lowerName.includes("delete") || lowerName.includes("remove")) {
    return "delete";
  }
  
  if (lowerName.includes("move") || lowerName.includes("rename")) {
    return "move";
  }
  
  if (lowerName.includes("search") || lowerName.includes("find") || lowerName.includes("grep")) {
    return "search";
  }
  
  if (lowerName.includes("run") || lowerName.includes("execute") || lowerName.includes("bash")) {
    return "execute";
  }
  
  if (lowerName.includes("think") || lowerName.includes("plan") || lowerName.includes("todo")) {
    return "think";
  }
  
  if (lowerName.includes("fetch") || lowerName.includes("download") || lowerName.includes("web")) {
    return "fetch";
  }
  
  return "other";
}

// Helper: Check if message has Claude session ID
export function hasSessionId(message: any): message is { session_id: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    "session_id" in message &&
    typeof message.session_id === "string"
  );
}

// Permission mode markers for dynamic switching
export const PERMISSION_MARKERS = {
  ACCEPT_EDITS: "[ACP:PERMISSION:ACCEPT_EDITS]",
  BYPASS: "[ACP:PERMISSION:BYPASS]",
  DEFAULT: "[ACP:PERMISSION:DEFAULT]",
  PLAN: "[ACP:PERMISSION:PLAN]",
} as const;

// Helper: Detect and extract permission mode from prompt
export function detectPermissionMode(promptText: string): PermissionModeType | null {
  if (promptText.includes(PERMISSION_MARKERS.ACCEPT_EDITS)) {
    return "acceptEdits";
  }
  if (promptText.includes(PERMISSION_MARKERS.BYPASS)) {
    return "bypassPermissions";
  }
  if (promptText.includes(PERMISSION_MARKERS.DEFAULT)) {
    return "default";
  }
  if (promptText.includes(PERMISSION_MARKERS.PLAN)) {
    return "plan";
  }
  return null;
}
