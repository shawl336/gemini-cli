#!/usr/bin/env python3
"""
A2A Client Demo for Gemini CLI

This script demonstrates how to use the Gemini CLI A2A server with custom tools.
It creates a task, sends a message, and handles tool calls.
"""

import asyncio
import json
import uuid
from typing import Dict, Any, List, Optional
from a2a.client import ClientFactory, ClientConfig, A2ACardResolver
from a2a.types import (
  Message, Part, TextPart, Role, Artifact, DataPart, FilePart,
  AgentCard,
  MessageSendParams,
  SendMessageRequest,
  SendStreamingMessageRequest,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  AgentCapabilities,
  TaskState,
)
import httpx
import sys
from pathlib import Path


# 1. Define your custom local tool
def get_local_weather(city: str):
  # In a real scenario, this would hit a local sensor or specific API
  return f"The weather in {city} is currently 22°C and sunny (fetched via Client Tool)."

async def run_a2a_client_demo():
  async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, read=300.0)) as httpx_client:
    # Resolve the agent
    resolver = A2ACardResolver(httpx_client=httpx_client, base_url="http://localhost:40095")
    agent_card = await resolver.get_agent_card()
    print(f"Resolved Agent: {agent_card.name} )")
    # Initialize client with streaming enabled
    client = ClientFactory(ClientConfig(streaming=True)).create(agent_card)

    # Send initial request
    msg = Message(
        role=Role.user,
        parts=[Part(root=TextPart(text="make a foo dir under cwd."))],
        message_id=uuid.uuid4().hex,
    )

    # Define custom tools for the request
    custom_tools_metadata = {
        "custom_tools": {
            "get_local_weather": {
                "description": "Get the local weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "city": {
                            "type": "string",
                            "description": "The city to get weather for"
                        }
                    },
                    "required": ["city"]
                }
            }
        }
    }

    done = False
    new_msg = None
    try:
      while not done:
        tool_call_in_progress = False
        # 2. The Execution Loop
        msg = new_msg if new_msg else msg
        new_msg = None  # Reset for next iteration
        assert msg
        print("\n--- Sending Message ---")
        async for response in client.send_message(request=msg):
            if isinstance(response, Message): 
              for part in response.parts:
                  # NEW PATTERN: Check for tool_call within the part
                  print(part.root.text)
            else:
              event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent | None = response[1]
              # task = response[0]
              if isinstance(event, TaskArtifactUpdateEvent):  
                artifact: Artifact = event.artifact
                print(f"Received artifact update: {artifact.artifact_id}")
              elif isinstance(event, TaskStatusUpdateEvent):
                metadata = event.metadata or {}
                recv_msg = event.status.message
                if recv_msg:
                  for part in recv_msg.parts:
                    if isinstance(part.root, TextPart):
                      print(part.root.text)
                    elif isinstance(part.root, DataPart):
                        tool_request = part.root.data.get("request", {})
                        coder_agent_kind = metadata.get("coderAgent", {}).get("kind", "")
                      # Handle the tool call
                        if coder_agent_kind == "tool-call-confirmation":
                          print(f"[Tool Call Confirmation] {json.dumps(part.root.data)}")
                          # Prepare approval message for next iteration
                          input()
                          new_msg = Message(
                              role=Role.user,
                              parts=[Part(root=DataPart(data={"callId": tool_request.get("callId", ""), "outcome": "proceed_once"}))],
                              message_id=uuid.uuid4().hex,
                              task_id=event.task_id,
                          )
                          tool_call_in_progress = True
                        elif coder_agent_kind == "tool-call-update":
                          print(f"[Tool Call Update] {json.dumps(tool_request.get("name", "toolName"))}")

                    elif isinstance(part.root, FilePart):
                        print(f"[File Part] Received file")
                if event.final:
                  if not tool_call_in_progress:
                    done = True
                  # Continue consuming the stream until it's exhausted
        
        # Stream is now properly closed, safe to continue to next iteration
    except GeneratorExit:
        # This happens if the loop is broken externally or connection drops
        print("\n[Warning] Stream was closed by the client or server early.")
    finally:
        print("\n--- Stream Consumption Ended ---")

# async def simple_task_demo():
#     """Simple demo without custom tools."""
#     async with A2AClient() as client:
#         try:
#             context_id = str(uuid.uuid4())
#             print(f"Using context ID: {context_id}")

#             print("\nCreating simple task...")
#             task_id = await client.create_task(
#                 context_id=context_id,
#                 workspace_path="/tmp/a2a-demo-workspace"
#             )
#             print(f"✓ Created task: {task_id}")

#             message = "Hello! Can you help me create a simple Python script that prints 'Hello, World!'?"
#             print(f"\nSending message: {message}")

#             response = await client.send_message(context_id, task_id, message)
#             print(f"✓ Message sent. Response ID: {response.get('id', 'unknown')}")

#             # Get task metadata
#             metadata = await client.get_task_metadata(task_id)
#             print(f"\n✓ Task metadata retrieved")
#             print(f"Task state: {metadata.get('taskState', 'unknown')}")
#             print(f"Model: {metadata.get('model', 'unknown')}")
#             print(f"MCP servers: {len(metadata.get('mcpServers', []))}")
#             print(f"Available tools: {len(metadata.get('availableTools', []))}")

#         except httpx.ConnectError:
#             print("\n❌ Connection Error: Cannot connect to A2A server")
#             print("Make sure the A2A server is running:")
#             print("  npm run start:a2a-server")
#         except httpx.HTTPStatusError as e:
#             print(f"\n❌ HTTP Error: {e.response.status_code}")
#             print(f"Response: {e.response.text}")
#         except Exception as e:
#             print(f"\n❌ Error: {e}")
#             import traceback
#             traceback.print_exc()


async def main():
    """Main demo function."""
    print("🤖 Gemini CLI A2A Client Demo")
    print("=" * 40)
    await run_a2a_client_demo()

    print("\n" + "=" * 40)
    print("Demo completed!")  


if __name__ == "__main__":
    asyncio.run(main())