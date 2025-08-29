/**
 * Zed Claude ACP Server - Agent Implementation
 * 
 * Core ACP Agent that bridges Claude Code SDK with Zed's External Agent protocol.
 */

import { query } from "@anthropic-ai/claude-code";
import type { SDKMessage } from "@anthropic-ai/claude-code";
import {
  Agent,
  Client,
  PROTOCOL_VERSION,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  AuthenticateRequest,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  LoadSessionRequest,
} from "@zed-industries/agent-client-protocol";

import {
  SessionState,
  ClaudeMessage,
  ClaudeStreamEvent,
  PermissionModeType,
  parsePermissionMode,
  extractTextBlocks,
  detectPermissionMode,
  hasSessionId,
  mapToolKind,
} from "./types.js";

/**
 * Main ACP Agent class for Zed Claude integration
 */
export class ZedClaudeAgent implements Agent {
  private readonly sessions: Map<string, SessionState> = new Map();
  private readonly debugMode: boolean;
  private readonly defaultPermissionMode: PermissionModeType;

  constructor(private readonly client: Client) {
    this.debugMode = process.env.ACP_DEBUG === "true";
    this.defaultPermissionMode = parsePermissionMode(process.env.ACP_PERMISSION_MODE);
    
    this.log("Agent initialized", {
      debugMode: this.debugMode,
      defaultPermissionMode: this.defaultPermissionMode,
    });
  }

  /**
   * Log to stderr when debug mode is enabled
   */
  private log(message: string, data?: unknown): void {
    if (this.debugMode) {
      const timestamp = new Date().toISOString();
      console.error(`[${timestamp}][ZedClaudeAgent] ${message}`);
      if (data) {
        console.error(JSON.stringify(data, null, 2));
      }
    }
  }

  /**
   * Initialize the ACP connection
   */
  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.log("Initialize request received");
    
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
      },
    };
  }

  /**
   * Create a new session
   */
  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    
    const sessionState: SessionState = {
      pendingPrompt: null,
      abortController: null,
      claudeSessionId: undefined,
      permissionMode: this.defaultPermissionMode,
      messageCount: 0,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    };
    
    this.sessions.set(sessionId, sessionState);
    
    this.log("New session created", {
      sessionId,
      permissionMode: sessionState.permissionMode,
    });
    
    return { sessionId };
  }

  /**
   * Load an existing session
   */
  async loadSession(params: LoadSessionRequest): Promise<void> {
    this.log("Load session request", { sessionId: params.sessionId });
    
    if (this.sessions.has(params.sessionId)) {
      this.log("Session already exists", { sessionId: params.sessionId });
      return;
    }
    
    // Create new session entry for restored session
    const sessionState: SessionState = {
      pendingPrompt: null,
      abortController: null,
      claudeSessionId: undefined,
      permissionMode: this.defaultPermissionMode,
      messageCount: 0,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    };
    
    this.sessions.set(params.sessionId, sessionState);
    
    this.log("Session loaded", { sessionId: params.sessionId });
  }

  /**
   * Authenticate (no-op as Claude CLI handles this)
   */
  async authenticate(_params: AuthenticateRequest): Promise<void> {
    this.log("Authentication requested - delegating to Claude Code SDK");
    // Claude Code SDK handles authentication via ~/.claude/config.json
  }

  /**
   * Process a user prompt
   */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const { sessionId } = params;
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      this.log("Session not found", { sessionId });
      throw new Error(`Session ${sessionId} not found`);
    }
    
    this.log("Processing prompt", {
      sessionId,
      hasClaudeSession: !!session.claudeSessionId,
      permissionMode: session.permissionMode,
    });
    
    // Cancel any ongoing prompt
    this.cancelCurrentPrompt(session);
    
    // Create new abort controller
    session.abortController = new AbortController();
    session.lastActiveAt = new Date();
    
    try {
      // Extract text content
      const promptText = extractTextBlocks(params.prompt);
      
      this.log("Prompt extracted", {
        textLength: promptText.length,
        preview: promptText.substring(0, 100),
      });
      
      // Check for permission mode switching
      const newMode = detectPermissionMode(promptText);
      if (newMode) {
        session.permissionMode = newMode;
        this.log("Permission mode updated", { newMode });
      }
      
      // Prepare Claude query options
      const queryOptions: any = {
        maxTurns: 10,
        permissionMode: session.permissionMode,
      };
      
      if (session.claudeSessionId) {
        queryOptions.resume = session.claudeSessionId;
      }
      
      this.log("Starting Claude query", queryOptions);
      
      // Start Claude query
      const messageStream = query({
        prompt: promptText,
        options: queryOptions,
      });
      
      session.pendingPrompt = messageStream as AsyncIterableIterator<SDKMessage>;
      
      // Process stream
      await this.processMessageStream(sessionId, session, messageStream);
      
      this.log("Prompt processing completed", {
        sessionId,
        claudeSessionId: session.claudeSessionId,
      });
      
      return { stopReason: "end_turn" };
      
    } catch (error) {
      this.log("Prompt processing error", { sessionId, error: String(error) });
      
      if (session.abortController?.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      
      // Send error message to client
      await this.sendErrorMessage(sessionId, error);
      return { stopReason: "end_turn" };
      
    } finally {
      session.pendingPrompt = null;
      session.abortController = null;
    }
  }

  /**
   * Cancel an ongoing prompt
   */
  async cancel(params: CancelNotification): Promise<void> {
    this.log("Cancel request received", { sessionId: params.sessionId });
    
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      this.log("Cancel failed - session not found", { sessionId: params.sessionId });
      return;
    }
    
    this.cancelCurrentPrompt(session);
    this.log("Session cancelled", { sessionId: params.sessionId });
  }

  /**
   * Cancel the current prompt in a session
   */
  private cancelCurrentPrompt(session: SessionState): void {
    if (session.abortController) {
      session.abortController.abort();
    }
    
    if (session.pendingPrompt?.return) {
      session.pendingPrompt.return().catch((err) =>
        this.log("Error closing prompt iterator", err)
      );
      session.pendingPrompt = null;
    }
  }

  /**
   * Process the message stream from Claude
   */
  private async processMessageStream(
    sessionId: string,
    session: SessionState,
    messageStream: AsyncIterableIterator<SDKMessage>
  ): Promise<void> {
    let messageCount = 0;
    
    for await (const message of messageStream) {
      if (session.abortController?.signal.aborted) {
        this.log("Message processing aborted", { sessionId, messageCount });
        break;
      }
      
      messageCount++;
      session.messageCount++;
      
      // Update Claude session ID if available
      if (hasSessionId(message) && message.session_id !== session.claudeSessionId) {
        this.log("Claude session ID updated", {
          old: session.claudeSessionId,
          new: message.session_id,
        });
        session.claudeSessionId = message.session_id;
      }
      
      // Process the message
      await this.handleClaudeMessage(sessionId, message as ClaudeMessage);
    }
    
    this.log("Stream processing completed", { sessionId, messageCount });
  }

  /**
   * Handle individual Claude messages
   */
  private async handleClaudeMessage(
    sessionId: string,
    message: ClaudeMessage
  ): Promise<void> {
    const messageType = message.type;
    
    this.log("Handling Claude message", { type: messageType });
    
    switch (messageType) {
      case "system":
        // System messages are internal
        break;
        
      case "user":
        await this.handleUserMessage(sessionId, message);
        break;
        
      case "assistant":
        await this.handleAssistantMessage(sessionId, message);
        break;
        
      case "result":
        this.log("Query completed", { result: message.result });
        break;
        
      case "text":
        if (message.text) {
          await this.sendTextContent(sessionId, message.text);
        }
        break;
        
      case "tool_use_start":
        await this.handleToolUseStart(sessionId, message);
        break;
        
      case "tool_use_output":
        await this.handleToolUseOutput(sessionId, message);
        break;
        
      case "tool_use_error":
        await this.handleToolUseError(sessionId, message);
        break;
        
      case "stream_event":
        await this.handleStreamEvent(sessionId, message);
        break;
        
      default:
        this.log("Unhandled message type", { type: messageType });
    }
  }

  /**
   * Handle user messages with tool results
   */
  private async handleUserMessage(sessionId: string, message: ClaudeMessage): Promise<void> {
    if (!message.message?.content) return;
    
    for (const content of message.message.content) {
      if (content.type === "tool_result" && content.tool_use_id) {
        this.log("Tool result received", { toolUseId: content.tool_use_id });
        
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: content.tool_use_id,
            status: "completed",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: content.content || "",
                },
              },
            ],
            rawOutput: content.content ? { output: content.content } : undefined,
          },
        });
      }
    }
  }

  /**
   * Handle assistant messages
   */
  private async handleAssistantMessage(sessionId: string, message: ClaudeMessage): Promise<void> {
    if (message.message?.content) {
      for (const content of message.message.content) {
        if (content.type === "text" && content.text) {
          await this.sendTextContent(sessionId, content.text);
        } else if (content.type === "tool_use" && content.id && content.name) {
          await this.handleToolUseInAssistant(sessionId, content as { id: string; name: string; input?: Record<string, unknown> });
        }
      }
    } else if ("text" in message && message.text) {
      await this.sendTextContent(sessionId, message.text);
    }
  }

  /**
   * Handle tool use in assistant messages
   */
  private async handleToolUseInAssistant(
    sessionId: string,
    content: { id: string; name: string; input?: Record<string, unknown> }
  ): Promise<void> {
    this.log("Tool use in assistant message", {
      toolName: content.name,
      toolId: content.id,
    });
    
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: content.id,
        title: content.name,
        kind: mapToolKind(content.name),
        status: "pending",
        rawInput: content.input || {},
      },
    });
    
    // Special handling for TodoWrite
    if (content.name === "TodoWrite" && content.input?.todos) {
      await this.sendTodoList(sessionId, content.input.todos as any[]);
    }
  }

  /**
   * Handle tool use start
   */
  private async handleToolUseStart(sessionId: string, message: ClaudeMessage): Promise<void> {
    const { id = "", tool_name = "", input = {} } = message;
    
    this.log("Tool use started", { toolName: tool_name, toolId: id });
    
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: tool_name,
        kind: mapToolKind(tool_name),
        status: "pending",
        rawInput: input as Record<string, unknown>,
      },
    });
    
    // Special handling for TodoWrite
    if (tool_name === "TodoWrite" && input && typeof input === "object" && "todos" in input) {
      await this.sendTodoList(sessionId, (input as any).todos);
    }
  }

  /**
   * Handle tool use output
   */
  private async handleToolUseOutput(sessionId: string, message: ClaudeMessage): Promise<void> {
    const { id = "", output = "" } = message;
    
    this.log("Tool use completed", { toolId: id });
    
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: output,
            },
          },
        ],
        rawOutput: output ? { output } : undefined,
      },
    });
  }

  /**
   * Handle tool use error
   */
  private async handleToolUseError(sessionId: string, message: ClaudeMessage): Promise<void> {
    const { id = "", error = "Unknown error" } = message;
    
    this.log("Tool use failed", { toolId: id, error });
    
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "failed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `❌ Error: ${error}`,
            },
          },
        ],
        rawOutput: { error },
      },
    });
  }

  /**
   * Handle streaming events
   */
  private async handleStreamEvent(sessionId: string, message: ClaudeMessage): Promise<void> {
    const event = message.event as ClaudeStreamEvent;
    
    if (event.type === "content_block_start" && event.content_block?.type === "text") {
      await this.sendTextContent(sessionId, event.content_block.text || "");
    } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      await this.sendTextContent(sessionId, event.delta.text || "");
    } else if (event.type === "content_block_stop") {
      this.log("Content block streaming completed");
    }
  }

  /**
   * Send text content to client
   */
  private async sendTextContent(sessionId: string, text: string): Promise<void> {
    if (!text) return;
    
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text,
        },
      },
    });
  }

  /**
   * Send formatted todo list
   */
  private async sendTodoList(
    sessionId: string,
    todos: Array<{ content: string; status: string }>
  ): Promise<void> {
    if (!Array.isArray(todos)) return;
    
    let todoText = "\n📝 Todo List:\n";
    todos.forEach((todo, index) => {
      const statusEmoji = this.getStatusEmoji(todo.status);
      todoText += `  ${index + 1}. ${statusEmoji} ${todo.content}\n`;
    });
    
    await this.sendTextContent(sessionId, todoText);
  }

  /**
   * Get emoji for todo status
   */
  private getStatusEmoji(status: string): string {
    switch (status) {
      case "completed":
        return "✅";
      case "in_progress":
        return "🔄";
      case "pending":
        return "⏳";
      default:
        return "📋";
    }
  }

  /**
   * Send error message to client
   */
  private async sendErrorMessage(sessionId: string, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `❌ Error: ${errorMessage}`,
        },
      },
    });
  }
}
