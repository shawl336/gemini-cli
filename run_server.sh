export GOOGLE_GEMINI_BASE_URL="https://api.openai-proxy.org/google"
export GEMINI_API_KEY="sk-pYmeN1FKWyur6RC2gHm52nsEuIMvyIQO80O9c2QxgknOdD7v"
# 通过环境变量设置模型：
export GEMINI_MODEL=gemini-2.5-flash-lite
# 使用端口 40095：
CODER_AGENT_PORT=40095 node packages/a2a-server/dist/src/http/server.js
