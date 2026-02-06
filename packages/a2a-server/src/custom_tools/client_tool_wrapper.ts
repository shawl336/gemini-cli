/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult, ToolInvocation, MessageBus } from '@google/gemini-cli-core';
import { Kind, BaseDeclarativeTool, BaseToolInvocation } from '@google/gemini-cli-core';
import type { ExecutionEventBus } from '@a2a-js/sdk/server';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import type { FrontendTool } from '../types.js';
import { CoderAgentEvent } from '../types.js';

type ToolParams = Record<string, unknown>;

/**
 * 客户端工具调用类
 * 
 * 当Gemini决定调用客户端提供的工具时，会创建此类的实例
 * 主要功能：
 * 1. 通过 eventBus 发送工具调用请求给客户端（通过SSE流）
 * 2. 等待客户端执行工具并返回结果
 * 3. 处理超时和错误情况
 * 
 * 工作流程：
 * 1. Gemini调用工具 -> execute()方法被调用
 * 2. execute()通过eventBus.publish()发送status-update事件给客户端
 * 3. 客户端通过SSE接收到事件，检测到工具调用（agent_framework6e.py第914-930行）
 * 4. 客户端执行工具并返回结果（通过HTTP POST或SSE）
 * 5. handleClientResult()或handleClientError()被调用来处理结果
 * 6. Promise被resolve/reject，工具调用完成
 */
class FrontendToolInvocation extends BaseToolInvocation<ToolParams, ToolResult> {
  private callId: string;
  private eventBus: ExecutionEventBus;
  private taskId: string;
  private contextId: string;
  private resolveCallback?: (result: ToolResult) => void;
  private rejectCallback?: (error: Error) => void;
  private timeoutId?: NodeJS.Timeout;
  private result?: ToolResult;

  constructor(
    params: ToolParams,
    messageBus: MessageBus,
    toolName: string,
    toolDisplayName: string,
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
    this.callId = uuidv4();
    this.eventBus = eventBus;
    this.taskId = taskId;
    this.contextId = contextId;
  }

  getDescription(): string {
    return `Client tool: ${this._toolName}`;
  }

  /**
   * 执行客户端工具调用
   * 当Gemini决定调用客户端工具时，会调用此方法
   * 此方法会通过eventBus发送工具调用请求给客户端，然后等待客户端返回执行结果
   */
  async execute(
    _signal: AbortSignal,
    _updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve, reject) => {
      // If the frontend results are already saved, use it directly
      let result: ToolResult
      if (this.result) {
        result = this.result
      } else {
        result = {
          llmContent: "Failed to execute frontend tool",
          returnDisplay: "Failed to execute frontend tool",
          error: {
            message: "Failed to execute frontend tool",
          },
        }        
      }

      resolve(result);
      this.result = undefined; // reset the result for next calls  
    }
  )}

        /**
   * 执行客户端工具调用
   * 当Gemini决定调用客户端工具时，会调用此方法
   * 此方法会通过eventBus发送工具调用请求给客户端，然后等待客户端返回执行结果
   */
  async execute_old(
    _signal: AbortSignal,
    _updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve, reject) => {
      // If the frontend results are already saved, use it directly
      this.resolveCallback = resolve;
      this.rejectCallback = reject;

    // 设置超时（60秒），如果客户端在规定时间内没有返回结果，则超时失败
      this.timeoutId = setTimeout(() => {
        if (this.rejectCallback) {
          this.rejectCallback(
            new Error(
              `Client tool "${this._toolName}" execution timeout after 30 seconds`,
            ),
          );
        }
      }, 60000);

      // ⭐ 服务端发送工具调用请求给客户端 - 打印日志位置
      // 当服务端需要调用客户端工具时，会在这里打印日志并发送事件
      logger.info(
        `[ClientTool] Sending tool call request to client: ${this._toolName} (callId: ${this.callId})`,
      );

      // 构建工具调用数据，用于客户端检测和处理
      // 这个数据结构会被放在SSE事件的message.parts中，客户端会解析这个数据来识别工具调用
      const toolCallData = {
        tool_name: this._toolName,        // 工具名称（客户端会使用此字段）
        toolName: this._toolName,         // 工具名称（备用字段名）
        callId: this.callId,             // 工具调用ID
        tool_call_id: this.callId,       // 工具调用ID（备用字段名）
        status: 'pending',               // 工具调用状态：pending（待执行）
        input_parameters: this.params,   // 工具调用参数（客户端会使用此字段）
        inputParameters: this.params,    // 工具调用参数（备用字段名）
        request: {                        // 完整的工具调用请求信息
          callId: this.callId,
          name: this._toolName,
          args: this.params,
        },
      };

      // ⭐ 通过eventBus发布工具调用事件，客户端会通过SSE流接收到此事件
      // 事件格式：status-update，包含message.parts中的data类型part
      // 客户端在agent_framework6e.py的第914-930行会检测并处理这个事件
      this.eventBus.publish({
        kind: 'status-update',           // 事件类型：状态更新
        taskId: this.taskId,
        contextId: this.contextId,
        status: {
          state: 'working',              // 任务状态：工作中
          timestamp: new Date().toISOString(),
          message: {
            kind: 'message',
            role: 'agent',
            parts: [
              {
                kind: 'data',            // ⭐ 关键：data类型的part，客户端会检测这个
                data: toolCallData,      // 工具调用数据，客户端会解析这个来识别工具调用
              },
            ],
            messageId: uuidv4(),
            taskId: this.taskId,
            contextId: this.contextId,
          },
        },
        final: false,                     // 非最终事件，表示还有后续响应
          metadata: {
            coderAgent: {
              kind: CoderAgentEvent.ToolCallConfirmationEvent,  // 工具调用确认事件类型
              toolCallId: this.callId,
              toolName: this._toolName,
              toolParams: this.params,
            },
          },
      });
    });
  }


  saveClientResult(result: ToolResult): void {
    this.result = result;
  }

  /**
   * Called when client returns tool execution result
   */
  handleClientResult(result: ToolResult): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    if (this.resolveCallback) {
      logger.info(
        `[ClientTool] Received result for tool call ${this._toolName} (callId: ${this.callId})`,
      );
      this.resolveCallback(result);
    }
  }

  /**
   * Called when client tool execution fails
   */
  handleClientError(error: Error): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    if (this.rejectCallback) {
      logger.error(
        `[ClientTool] Error executing tool ${this._toolName} (callId: ${this.callId}): ${error.message}`,
      );
      this.rejectCallback(error);
    }
  }

  getCallId(): string {
    return this.callId;
  }
}

/**
 * Wrapper for client-provided tools that delegates execution to the client.
 */
export class FrontendToolWrapper extends BaseDeclarativeTool<
  Record<string, unknown>,
  ToolResult
> {
  private eventBus?: ExecutionEventBus;
  private taskId?: string;
  private contextId?: string;
  private pendingInvocations: Map<string, FrontendToolInvocation> = new Map();

  constructor(
    frontendTool: FrontendTool,
    messageBus: MessageBus,
    eventBus?: ExecutionEventBus,
    taskId?: string,
    contextId?: string,
  ) {
    super(
      frontendTool.name,
      frontendTool.name,
      frontendTool.description,
      Kind.Other,
      frontendTool.parameterSchema,
      messageBus,
      false, // isOutputMarkdown
      false, // canUpdateOutput
    );
    this.eventBus = eventBus;
    this.taskId = taskId;
    this.contextId = contextId;
  }

  /**
   * Set event bus and task context for tool execution
   */
  setContext(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
  ): void {
    this.eventBus = eventBus;
    this.taskId = taskId;
    this.contextId = contextId;
  }

  protected createInvocation(
    params: Record<string, unknown>,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<Record<string, unknown>, ToolResult> {
    if (!this.eventBus || !this.taskId || !this.contextId) {
      throw new Error(
        'FrontendToolWrapper context not set. Call setContext() before using the tool.',
      );
    }

    const invocation = new FrontendToolInvocation(
      params,
      messageBus,
      toolName || this.name,
      toolDisplayName || this.displayName,
      this.eventBus,
      this.taskId,
      this.contextId,
    );

    // Store invocation for result handling
    this.pendingInvocations.set(invocation.getCallId(), invocation);

    return invocation;
  }

  // For frontend tool results, which are pre-stored and returned immediately at invocation
  // this trick makes the tool calls pretentiously called on the Gemini side
  saveToolResult(callId: string, result: ToolResult): void {
    const invocation = this.pendingInvocations.get(callId);
    if (invocation) {
      invocation.saveClientResult(result);
      this.pendingInvocations.delete(callId);
    } else {
      logger.warn(
        `[ClientTool] Received result for unknown tool call: ${callId}`,
      );
    }
  }

  /**
   * Handle tool execution result from client
   */
  handleToolResult(callId: string, result: ToolResult): void {
    const invocation = this.pendingInvocations.get(callId);
    if (invocation) {
      invocation.handleClientResult(result);
      this.pendingInvocations.delete(callId);
    } else {
      logger.warn(
        `[ClientTool] Received result for unknown tool call: ${callId}`,
      );
    }
  }

  /**
   * Handle tool execution error from client
   */
  handleToolError(callId: string, error: Error): void {
    const invocation = this.pendingInvocations.get(callId);
    if (invocation) {
      invocation.handleClientError(error);
      this.pendingInvocations.delete(callId);
    } else {
      logger.warn(
        `[ClientTool] Received error for unknown tool call: ${callId}`,
      );
    }
  }
}
