# Providers — reference

Researched 2026-09-29 from each vendor's documentation (third-party sources are named where used).
Prices are USD per million tokens: input / cached input / output. Recheck before relying on a
price; vendors change them often. Used by the provider registry in
[lead-and-decisions](./lead-and-decisions.md).

| Vendor | API (base URL) | Key env | Models | Price | Tools + JSON schema | Coding CLI (headless) |
|--------|----------------|---------|--------|-------|---------------------|-----------------------|
| Anthropic | Messages API, `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1` (1M ctx) | Opus 5.5 4 / — / 20; Sonnet 5.5 2 / — / 10 | native tool use and structured outputs | Claude Code: `claude -p --output-format json --json-schema` |
| OpenAI | Responses API, `https://api.openai.com/v1` | `OPENAI_API_KEY` | `gpt-6-sol` (coding, 1.05M ctx), `gpt-6-astra`, `gpt-6-luna` | sol 2.00 / 0.20 / 10.00 | yes — use Responses: Chat Completions allows tools only with `reasoning_effort: none` | Codex CLI: `codex exec --json --output-schema` |
| xAI | `https://api.x.ai/v1`, Responses (Chat Completions is legacy) | `XAI_API_KEY` | `grok-4.7` (500k ctx), `grok-4.3` (1M), `grok-build-0.1` | grok-4.7 2.00 / 0.50 / 6.00, doubled above 200k-token prompts | function calling, `json_schema` | Grok Build, `-p` headless (beta; binary name and output modes unconfirmed) |
| Moonshot (Kimi) | OpenAI-compatible, `https://api.moonshot.ai/v1` (`.cn` in China) | `MOONSHOT_API_KEY` | `kimi-k3` (1M ctx), `kimi-k2.7-code` (262k) | k3 3.00 / 0.30 / 15.00 (+ cache writes); k2.7-code 0.95 / 0.19 / 4.00 | `tools` (not `functions`); `tool_choice: required` only on k3; k3 `json_schema` strict | Kimi Code: `kimi -p --output-format stream-json` |
| Z.ai (GLM) | OpenAI-compatible, `https://api.z.ai/api/paas/v4` (`open.bigmodel.cn` in China); Coding Plan keys use `/api/coding/paas/v4` | unconfirmed (`ZAI_API_KEY` / `ZHIPUAI_API_KEY`) | `glm-5.3` (1M ctx), `glm-5.3-flash` | 5.3 1.40 / 0.26 / 4.40; flash 0.15 / 0.03 / 0.50 | function calling, `json_schema` | ZCode, `zcode -p` (third-party source; output format unconfirmed) |

## Gotchas

- Verdicts through a tool work with every vendor. Use the native APIs for Anthropic (its
  OpenAI-compatible layer ignores `strict` and `response_format`) and OpenAI (Responses).
- Reasoning is always on for `kimi-k3` and `glm-5.3`. Kimi needs the whole assistant message,
  `reasoning_content` included, sent back each turn; parse only `content`. `kimi-k3` fixes its
  sampling (`temperature` 1.0, `top_p` 0.95): leave those parameters out.
- xAI doubles prices above 200k-token prompts and returns reasoning encrypted.
- GLM Coding Plan keys work only on the coding endpoints.
- CLI cost is reported as $0 by the current adapters; the registry must price by model.
