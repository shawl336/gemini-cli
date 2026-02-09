/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  type ToolResult,
  Kind,
  type ToolAskUserConfirmationDetails,
  type ToolConfirmationPayload,
  ToolConfirmationOutcome,
} from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { QuestionType, type Question } from '../confirmation-bus/types.js';
import { ASK_USER_TOOL_NAME, ASK_USER_DISPLAY_NAME } from './tool-names.js';

export interface AskUserParams {
  questions: Question[];
}

/**
 * @lx-TODO: A simplified AskUserTool that accepts only text and yesno questions in place of the original "AskUserTool".
 * Support Choice UI in the frontend to remove this tool in the future.
 */
export class AskUserTool extends BaseDeclarativeTool<
  AskUserParams,
  ToolResult
> {
  constructor(messageBus: MessageBus) {
    super(
      ASK_USER_TOOL_NAME,
      ASK_USER_DISPLAY_NAME,
      'Ask the user one or more questions to gather preferences, clarify requirements, or make decisions.',
      Kind.Communicate,
      {
        type: 'object',
        required: ['questions'],
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              required: ['question', 'header'],
              properties: {
                question: {
                  type: 'string',
                  description:
                    'The complete question to ask the user. Should be clear, specific, and end with a question mark.',
                },
                header: {
                  type: 'string',
                  maxLength: 16,
                  description:
                    'Very short label displayed as a chip/tag (max 16 chars). Examples: "Auth method", "Library", "Approach".',
                },
                type: {
                  type: 'string',
                  enum: ['text', 'yesno'],
                  default: 'text',
                  description:
                    "Question type: 'text' for free-form input, 'yesno' for Yes/No confirmation.",
                },
                placeholder: {
                  type: 'string',
                  description:
                    "Hint text shown in the input field. For type='text', shown in the main input. For type='choice', shown in the 'Other' custom input.",
                },
              },
            },
          },
        },
      },
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: AskUserParams,
  ): string | null {
    if (!params.questions || params.questions.length === 0) {
      return 'At least one question is required.';
    }

    return null;
  }

  protected createInvocation(
    params: AskUserParams,
    messageBus: MessageBus,
    toolName: string,
    toolDisplayName: string,
  ): AskUserInvocation {
    return new AskUserInvocation(params, messageBus, toolName, toolDisplayName);
  }
}

export class AskUserInvocation extends BaseToolInvocation<
  AskUserParams,
  ToolResult
> {
  private confirmationOutcome: ToolConfirmationOutcome | null = null;
  private userAnswers: { [questionIndex: string]: string } = {};

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolAskUserConfirmationDetails | false> {
    const normalizedQuestions = this.params.questions.map((q) => ({
      ...q,
      type: q.type ?? QuestionType.CHOICE,
    }));

    return {
      type: 'ask_user',
      title: 'Ask User',
      questions: normalizedQuestions,
      onConfirm: async (
        outcome: ToolConfirmationOutcome,
        payload?: ToolConfirmationPayload,
      ) => {
        this.confirmationOutcome = outcome;
        if (payload && 'answers' in payload) {
          this.userAnswers = payload.answers;
        }
      },
    };
  }

  getDescription(): string {
    return `Asking user: ${this.params.questions.map((q) => q.question).join(', ')}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    if (this.confirmationOutcome === ToolConfirmationOutcome.Cancel) {
      return {
        llmContent: 'User dismissed ask_user dialog without answering.',
        returnDisplay: 'User dismissed dialog',
      };
    }

    const answerEntries = Object.entries(this.userAnswers);
    const hasAnswers = answerEntries.length > 0;

    const returnDisplay = hasAnswers
      ? `**User answered:**\n${answerEntries
          .map(([index, answer]) => {
            const question = this.params.questions[parseInt(index, 10)];
            const category = question?.header ?? `Q${index}`;
            return `  ${category} → ${answer}`;
          })
          .join('\n')}`
      : 'User submitted without answering questions.';

    return {
      llmContent: JSON.stringify({ answers: this.userAnswers }),
      returnDisplay,
    };
  }
}
