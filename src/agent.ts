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
  private readonly locale: 'ko' | 'en';
  private readonly showThinking: boolean;
  private readonly timeoutMs: number;
  private readonly enableBypass: boolean;
  private readonly textBuffers: Map<string, { buf: string; timer: NodeJS.Timeout | null }> = new Map();
  private readonly textBufferMs: number;
  private readonly maxToolOutputBytes: number;
  private readonly sessionTtlMs: number;
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(private readonly client: Client) {
    this.debugMode = process.env.ACP_DEBUG === "true";
    this.defaultPermissionMode = parsePermissionMode(process.env.ACP_PERMISSION_MODE);
    this.locale = this.parseLocale(process.env.ACP_LANG || process.env.ACP_LOCALE);
    this.showThinking = (process.env.ACP_THINKING_MESSAGE ?? 'true') === 'true';
    this.timeoutMs = this.parseTimeout(process.env.ACP_TIMEOUT_MS);
    this.enableBypass = (process.env.ACP_ENABLE_BYPASS ?? 'true') === 'true';
    this.textBufferMs = this.parseNumber(process.env.ACP_TEXT_BUFFER_MS, 60, 0, 1000);
    this.maxToolOutputBytes = this.parseNumber(process.env.ACP_MAX_TOOL_OUTPUT_BYTES, 16 * 1024, 1024, 512 * 1024);
    this.sessionTtlMs = this.parseNumber(process.env.ACP_SESSION_TTL_MS, 30 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
    
    this.log("Agent initialized", {
      debugMode: this.debugMode,
      defaultPermissionMode: this.defaultPermissionMode,
      locale: this.locale,
      showThinking: this.showThinking,
      timeoutMs: this.timeoutMs,
      enableBypass: this.enableBypass,
      textBufferMs: this.textBufferMs,
      maxToolOutputBytes: this.maxToolOutputBytes,
      sessionTtlMs: this.sessionTtlMs,
    });

    // Start session GC timer
    this.startSessionGc();
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

    // Send thinking message (optional)
    if (this.showThinking) {
      await this.sendTextContent(sessionId, this.t('thinking'));
    }
    
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
        if (newMode === 'bypassPermissions' && !this.enableBypass) {
          // Gate bypass mode for safety
          await this.sendTextContent(sessionId, this.t('bypass_blocked'));
        } else {
          session.permissionMode = newMode;
          this.log("Permission mode updated", { newMode });
          await this.sendTextContent(sessionId, this.t('mode_switched', { mode: newMode }));
        }
      }
      
      // Prepare Claude query options
      const queryOptions: Record<string, unknown> = {
        maxTurns: 10,
        permissionMode: session.permissionMode,
        signal: session.abortController.signal, // Pass abort signal to SDK
      };
      
      if (session.claudeSessionId) {
        queryOptions.resume = session.claudeSessionId;
      }
      
      this.log("Starting Claude query", queryOptions);

      // Set up configurable timeout
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new TimeoutError(`Timed out after ${this.timeoutMs} ms`));
        }, this.timeoutMs);
      });
      
      // Start Claude query and race against timeout
      const processingPromise = (async () => {
        const messageStream = query({
          prompt: promptText,
          options: queryOptions,
        });
        session.pendingPrompt = messageStream as AsyncIterableIterator<SDKMessage>;
        await this.processMessageStream(sessionId, session, messageStream);
      })();

      await Promise.race([processingPromise, timeoutPromise]);
      
      // Cleanup timeout
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      
      this.log("Prompt processing completed", {
        sessionId,
        claudeSessionId: session.claudeSessionId,
      });
      
      return { stopReason: "end_turn" };
      
    } catch (error) {
      this.log("Prompt processing error", { sessionId, error: String(error) });

      // Abort the controller on error (e.g., timeout)
      if (!session.abortController?.signal.aborted) {
        session.abortController?.abort();
      }
      
      if (error instanceof TimeoutError) {
        await this.sendErrorMessage(sessionId, error);
      }

      if (session.abortController?.signal.aborted && this.isAbortError(error)) {
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
    // Flush any buffered text at the end
    await this.flushTextBuffer(sessionId);
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
      await this.sendTodoList(sessionId, content.input.todos as Array<{ content: string; status: string }>);
    }
  }

  /**
   * Handle tool use start
   */
  private async handleToolUseStart(sessionId: string, message: ClaudeMessage): Promise<void> {
    const { id = "", tool_name = "", input = {} } = message;
    
    this.log("Tool use started", { toolName: tool_name, toolId: id });
    
    // Send start message with tool info
    await this.sendToolStartMessage(sessionId, tool_name, input as Record<string, unknown>);
    
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
      await this.sendTodoList(sessionId, (input as { todos: Array<{ content: string; status: string }> }).todos);
    }
  }

  /**
   * Handle tool use output
   */
  private async handleToolUseOutput(sessionId: string, message: ClaudeMessage): Promise<void> {
    const { id = "", output = "" } = message;
    
    this.log("Tool use completed", { toolId: id });
    
    const safe = this.truncateLargeText(String(output ?? ""), this.maxToolOutputBytes);

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
              text: this.t('tool_completed', { output: safe }),
            },
          },
        ],
        rawOutput: output ? { output: safe } : undefined,
      },
    });
  }

  /**
   * Handle tool use error
   */
  private async handleToolUseError(sessionId: string, message: ClaudeMessage): Promise<void> {
    const { id = "", error = "Unknown error" } = message;
    
    this.log("Tool use failed", { toolId: id, error });
    
    const safe = this.truncateLargeText(String(error ?? "Unknown error"), this.maxToolOutputBytes);

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
              text: this.t('tool_error', { error: safe }),
            },
          },
        ],
        rawOutput: { error: safe },
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
    this.bufferText(sessionId, text);
  }

  /**
   * Send formatted todo list
   */
  private async sendTodoList(
    sessionId: string,
    todos: Array<{ content: string; status: string }>
  ): Promise<void> {
    if (!Array.isArray(todos)) return;
    
    const completedCount = todos.filter(t => t.status === 'completed').length;
    const inProgressCount = todos.filter(t => t.status === 'in_progress').length;
    const pendingCount = todos.filter(t => t.status === 'pending').length;

    const pct = todos.length ? Math.round((completedCount / todos.length) * 100) : 0;
    const bar = this.progressBar(pct);

    let header = this.t('todo_header', { completed: String(completedCount), total: String(todos.length) });
    let todoText = `\n${header}\n${bar}\n`;
    
    todos.forEach((todo, index) => {
      const { emoji, indicator } = this.getStatusDisplay(todo.status);
      const prefix = index === todos.length - 1 ? '╰─' : '├─';
      todoText += `${prefix} ${emoji} ${indicator} ${todo.content}\n`;
    });
    
    // Add progress summary
    if (todos.length > 0) {
      todoText += `\n${this.t('todo_summary', { completed: String(completedCount), inProgress: String(inProgressCount), pending: String(pendingCount) })}\n`;
    }
    
    await this.sendTextContent(sessionId, todoText);
  }

  /**
   * Get emoji for todo status
   */
  private getStatusDisplay(status: string): { emoji: string; indicator: string } {
    switch (status) {
      case "completed":
        return { emoji: "✅", indicator: this.t('todo_done') };
      case "in_progress":
        return { emoji: "🛠️", indicator: this.t('todo_work') };
      case "pending":
        return { emoji: "⏳", indicator: this.t('todo_todo') };
      default:
        return { emoji: "📋", indicator: this.t('todo_unknown') };
    }
  }

  /**
   * Send tool start message with progress indication
   */
  private async sendToolStartMessage(
    sessionId: string, 
    toolName: string, 
    input: Record<string, unknown>
  ): Promise<void> {
    const toolEmoji = this.getToolEmoji(toolName);
    const description = this.getToolDescription(toolName, input);
    const body = this.t('tool_start', { tool: toolName, emoji: toolEmoji, desc: description });
    await this.sendTextContent(sessionId, body);
  }

  /**
   * Get appropriate emoji for tool
   */
  private getToolEmoji(toolName: string): string {
    const lowerName = toolName.toLowerCase();
    
    if (lowerName.includes('read') || lowerName.includes('view')) return '📖';
    if (lowerName.includes('write') || lowerName.includes('create')) return '✍️';
    if (lowerName.includes('edit') || lowerName.includes('update')) return '📝';
    if (lowerName.includes('delete') || lowerName.includes('remove')) return '🗑️';
    if (lowerName.includes('search') || lowerName.includes('find') || lowerName.includes('grep')) return '🔎';
    if (lowerName.includes('bash') || lowerName.includes('run') || lowerName.includes('execute')) return '🧪';
    if (lowerName.includes('todo')) return '✅';
    if (lowerName.includes('fetch') || lowerName.includes('web')) return '🌐';
    if (lowerName.includes('glob')) return '🗂️';
    
    return '🔧';
  }

  /**
   * Get human-readable description for tool
   */
  private getToolDescription(toolName: string, input: Record<string, unknown>): string {
    const lowerName = toolName.toLowerCase();
    
    if (lowerName.includes('read')) {
      return this.t('desc_read', { file: String((input as any).file_path ?? 'file') });
    }
    if (lowerName.includes('write')) {
      return this.t('desc_write', { file: String((input as any).file_path ?? 'file') });
    }
    if (lowerName.includes('edit')) {
      return this.t('desc_edit', { file: String((input as any).file_path ?? 'file') });
    }
    if (lowerName.includes('bash')) {
      const cmd = String(input.command || '').substring(0, 50);
      return this.t('desc_bash', { cmd: `${cmd}${cmd.length >= 50 ? '...' : ''}` });
    }
    if (lowerName.includes('search') || lowerName.includes('grep')) {
      return this.t('desc_search', { q: String((input as any).pattern ?? (input as any).query ?? 'pattern') });
    }
    if (lowerName.includes('glob')) {
      return this.t('desc_glob', { q: String((input as any).pattern ?? 'pattern') });
    }
    if (lowerName.includes('todo')) {
      return this.t('desc_todo');
    }
    if (lowerName.includes('fetch') || lowerName.includes('web')) {
      return this.t('desc_fetch', { url: String((input as any).url ?? 'URL') });
    }
    
    return this.t('desc_generic');
  }

  /**
   * Send error message to client
   */
  private async sendErrorMessage(sessionId: string, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const safe = this.truncateLargeText(errorMessage, this.maxToolOutputBytes);
    
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: this.t('system_error', { error: safe }),
        },
      },
    });
  }

  // --- Helpers: locale, timeout, errors, i18n, progress ---

  private parseLocale(input?: string): 'ko' | 'en' {
    const v = (input || '').toLowerCase();
    if (v.startsWith('en')) return 'en';
    return 'ko';
  }

  private parseTimeout(input?: string): number {
    const def = 60000;
    if (!input) return def;
    const n = Number(input);
    if (!Number.isFinite(n) || n < 1000) return def;
    return Math.min(n, 10 * 60 * 1000); // cap at 10 minutes
    }

  private parseNumber(input: string | undefined, def: number, min: number, max: number): number {
    if (!input) return def;
    const n = Number(input);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }

  private isAbortError(error: unknown): boolean {
    if (!error) return false;
    if (error instanceof Error && error.name === 'AbortError') return true;
    return String((error as any).message || '').toLowerCase().includes('abort');
  }

  private t(key: string, vars: Record<string, string> = {}): string {
    const dict = this.locale === 'en' ? this.en : this.ko;
    let s = dict[key] ?? key;
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
    return s;
  }

  private progressBar(pct: number): string {
    const blocks = 10;
    const filled = Math.round((pct / 100) * blocks);
    const bar = '▰'.repeat(filled) + '▱'.repeat(blocks - filled);
    return this.t('progress_bar', { bar, pct: String(pct) });
  }

  private bufferText(sessionId: string, text: string): void {
    const entry = this.textBuffers.get(sessionId) ?? { buf: '', timer: null };
    entry.buf += text;
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => {
      void this.flushTextBuffer(sessionId);
    }, this.textBufferMs);
    this.textBuffers.set(sessionId, entry);
  }

  private async flushTextBuffer(sessionId: string): Promise<void> {
    const entry = this.textBuffers.get(sessionId);
    if (!entry || !entry.buf) return;
    const payload = entry.buf;
    entry.buf = '';
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: payload },
      },
    });
  }

  private truncateLargeText(input: string, maxBytes: number): string {
    const bytes = Buffer.byteLength(input, 'utf8');
    if (bytes <= maxBytes) return input;
    let end = input.length;
    // Trim to maxBytes boundary
    while (Buffer.byteLength(input.slice(0, end), 'utf8') > maxBytes && end > 0) {
      end = Math.floor(end * 0.95);
    }
    const kept = input.slice(0, end);
    const truncatedBytes = bytes - Buffer.byteLength(kept, 'utf8');
    return `${kept}\n\n… (${truncatedBytes} bytes truncated)`;
  }

  private startSessionGc(): void {
    const intervalMs = Math.max(30 * 1000, Math.floor(this.sessionTtlMs / 6));
    this.gcTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) {
        const idle = now - s.lastActiveAt.getTime();
        const isActive = !!s.pendingPrompt || !!s.abortController;
        if (!isActive && idle > this.sessionTtlMs) {
          this.log('GC: removing idle session', { sessionId: id, idleMs: idle });
          // flush any pending text
          void this.flushTextBuffer(id);
          this.sessions.delete(id);
          this.textBuffers.delete(id);
        }
      }
    }, intervalMs);
  }

  // Locale dictionaries
  private readonly ko: Record<string, string> = {
    thinking: '🧠 생각 중…\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    bypass_blocked: '🛑 PERMISSION: BYPASS는 비활성화되어 있어 적용되지 않았어요.',
    mode_switched: '🔐 권한 모드 전환: {mode}',
    tool_completed: '🎉 도구 완료!\n\n{output}',
    tool_error: '❌ 도구 오류\n\n⚠️ {error}',
    todo_header: '╭─ 📋 작업 진행 상황 ({completed}/{total} 완료)',
    todo_summary: '📊 요약: {completed} ✅ | {inProgress} 🛠️ | {pending} ⏳',
    todo_done: '[DONE]',
    todo_work: '[WORK]',
    todo_todo: '[TODO]',
    todo_unknown: '[????]',
    tool_start: '{emoji} {tool} 시작…\n├─ {desc}\n└─ 실행 중 ⏳',
    desc_read: '파일 읽는 중: {file}',
    desc_write: '파일 작성 중: {file}',
    desc_edit: '파일 편집 중: {file}',
    desc_bash: '명령 실행 중: {cmd}',
    desc_search: '검색 중: "{q}"',
    desc_glob: '파일 찾는 중: {q}',
    desc_todo: '할 일 목록 업데이트 중',
    desc_fetch: '웹 페이지 가져오는 중: {url}',
    desc_generic: '도구 실행 중',
    system_error: '🚨 시스템 오류\n\n{error}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    progress_bar: '진행률 {pct}% | {bar}',
  };

  private readonly en: Record<string, string> = {
    thinking: '🧠 Thinking…\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    bypass_blocked: '🛑 PERMISSION: BYPASS is disabled and was ignored.',
    mode_switched: '🔐 Permission mode switched: {mode}',
    tool_completed: '🎉 Tool completed!\n\n{output}',
    tool_error: '❌ Tool error\n\n⚠️ {error}',
    todo_header: '╭─ 📋 Task Progress ({completed}/{total} completed)',
    todo_summary: '📊 Summary: {completed} ✅ | {inProgress} 🛠️ | {pending} ⏳',
    todo_done: '[DONE]',
    todo_work: '[WORK]',
    todo_todo: '[TODO]',
    todo_unknown: '[????]',
    tool_start: '{emoji} Starting {tool}…\n├─ {desc}\n└─ Running ⏳',
    desc_read: 'Reading file: {file}',
    desc_write: 'Writing file: {file}',
    desc_edit: 'Editing file: {file}',
    desc_bash: 'Executing command: {cmd}',
    desc_search: 'Searching for "{q}"',
    desc_glob: 'Globbing files: {q}',
    desc_todo: 'Updating TODO list',
    desc_fetch: 'Fetching web page: {url}',
    desc_generic: 'Running tool',
    system_error: '🚨 System Error\n\n{error}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    progress_bar: 'Progress {pct}% | {bar}',
  };
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}
