/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ToolResult,
  ToolInvocation,
  MessageBus,
} from '@google/gemini-cli-core';
import {
  Kind,
  BaseDeclarativeTool,
  BaseToolInvocation,
} from '@google/gemini-cli-core';
import type { ExecutionEventBus } from '@a2a-js/sdk/server';
// import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import type { FrontendTool } from '../types.js';
// import { CoderAgentEvent } from '../types.js';

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
 * 5. handleFrontendResult()或handleFrontendError()被调用来处理结果
 * 6. Promise被resolve/reject，工具调用完成
 */
class FrontendToolInvocation extends BaseToolInvocation<
  ToolParams,
  ToolResult
> {
  private result: ToolResult | undefined;
  private wrapper: FrontendToolWrapper;

  constructor(
    params: ToolParams,
    messageBus: MessageBus,
    toolName: string,
    toolDisplayName: string,
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    wrapper: FrontendToolWrapper,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
    this.wrapper = wrapper;
  }

  getDescription(): string {
    return `Frontend tool: ${this._toolName}`;
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
    // Check if result was already saved
    const pendingResult = this.wrapper.getAndRemoveAnyPendingResult();
    if (pendingResult) {
      logger.info(`[FrontendTool] Found pending result in wrapper, using it`);
      this.result = pendingResult;
    }

    // If still no result, return error
    if (this.result === undefined) {
      logger.error(
        `[FrontendTool] No result found for tool ${this._toolName}, execution failed`,
      );
      return {
        llmContent: 'Failed to execute frontend tool',
        returnDisplay: 'Failed to execute frontend tool',
        error: {
          message: 'Failed to execute frontend tool',
        },
      };
    }

    const result = this.result;
    this.result = undefined; // reset the result for next calls

    return result;
  }
}

/**
 * Wrapper for frontend-provided tools that delegates execution to the frontend.
 */
export class FrontendToolWrapper extends BaseDeclarativeTool<
  Record<string, unknown>,
  ToolResult
> {
  private eventBus?: ExecutionEventBus;
  private taskId?: string;
  private contextId?: string;
  // Store results that arrive after invocation is created but before execute is called
  // For simplicity, we use a Map keyed by callId, but also support getting "any" result
  private pendingResults: Map<string, ToolResult> = new Map();

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

  /**
   * createInvocation is created and the Ivocation instance is created before
   * the toolCallArprovalRequest is sent
   */
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
      this, // Pass wrapper reference so invocation can access pending results
    );

    logger.info(`[FrontendTool] Created invocation for ${this.name}`);

    return invocation;
  }

  // For saving frontend tool results which are pre-stored and returned immediately at invocation
  // this trick makes the tool calls pretentiously called on the Gemini side
  saveToolResult(callId: string, result: ToolResult): void {
    if (this.pendingResults.has(callId)) {
      logger.warn(
        `[FrontendTool] Pending result already exists for callId ${callId}, overwriting it`,
      );
    }
    this.pendingResults.set(callId, result);

    logger.info(
      `[FrontendTool] Result saved for callId ${callId}: ${JSON.stringify(result).substring(0, 100)}`,
    );
  }

  /**
   * Get and remove any pending result (used by invocation when executing)
   */
  getAndRemoveAnyPendingResult(): ToolResult | undefined {
    if (this.pendingResults.size === 0) {
      return undefined;
    }
    // Get the first (and typically only) pending result,
    // callId is actually not used as the key to retrieve
    const entry = this.pendingResults.entries().next();
    if (entry.done || !entry.value) {
      return undefined;
    }
    const [callId, result] = entry.value;
    this.pendingResults.delete(callId);

    return result;
  }
}
