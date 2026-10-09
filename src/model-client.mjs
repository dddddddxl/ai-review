import OpenAI from "openai";

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 120_000;

export function createModelClient(
  environment = process.env,
  { fetchImpl = fetch, OpenAIImpl = OpenAI } = {},
) {
  const format = normalizeFormat(environment.AI_API_FORMAT);
  const apiKey =
    environment.AI_API_KEY ||
    (format === "anthropic-messages"
      ? environment.ANTHROPIC_API_KEY
      : environment.OPENAI_API_KEY) ||
    "";
  const model =
    environment.AI_MODEL ||
    (format === "anthropic-messages"
      ? environment.ANTHROPIC_MODEL
      : environment.OPENAI_MODEL) ||
    "";
  const baseUrl =
    environment.AI_BASE_URL ||
    (format === "anthropic-messages"
      ? environment.ANTHROPIC_BASE_URL
      : environment.OPENAI_BASE_URL) ||
    (format === "anthropic-messages"
      ? DEFAULT_ANTHROPIC_BASE_URL
      : "");
  const configured = Boolean(apiKey && model);
  const insecureHttp = isInsecureHttp(baseUrl);

  if (
    configured &&
    insecureHttp &&
    environment.AI_ALLOW_INSECURE_HTTP !== "true"
  ) {
    throw new Error(
      "AI_BASE_URL uses HTTP; set AI_ALLOW_INSECURE_HTTP=true only for an approved test network",
    );
  }

  if (!configured) {
    return {
      configured,
      format,
      insecureHttp,
      model,
      async generateReview() {
        throw new Error("Model API is not configured");
      },
    };
  }

  if (format === "openai-responses") {
    const configuredTimeoutMs = positiveInteger(environment.AI_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const client = new OpenAIImpl({
      apiKey,
      baseURL: baseUrl || undefined,
      timeout: configuredTimeoutMs,
      maxRetries: 0,
      fetch: fetchImpl,
    });

    return {
      configured,
      format,
      insecureHttp,
      model,
      async generateReview({ instructions, input, maxOutputTokens, onMetadata, timeoutMs, signal }) {
        const response = await client.responses.create({
          model,
          store: false,
          max_output_tokens: maxOutputTokens,
          instructions,
          input,
        }, { timeout: positiveInteger(timeoutMs, configuredTimeoutMs), signal });
        onMetadata?.(compactMetadata({ status: response.status,
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          totalTokens: response.usage?.total_tokens }));
        return response.output_text?.trim() || "";
      },
    };
  }

  if (format === 'openai-chat') {
    const endpoint = chatCompletionsUrl(baseUrl);
    const configuredTimeoutMs = positiveInteger(environment.AI_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    return {
      configured, format, insecureHttp, model,
      async generateReview({ instructions, input, maxOutputTokens, onMetadata, disableThinking = false, timeoutMs, signal }) {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, stream: false, max_tokens: maxOutputTokens,
            // Opt-in for gateways/models that emit native tool delimiters in
            // plain text. Still parse only the final-answer field and retain
            // all existing completion/refusal checks; never execute markup.
            ...(environment.AI_CHAT_JSON_MODE === 'true' ? { response_format: { type: 'json_object' } } : {}),
            ...(disableThinking && /^glm-/i.test(model) ? { thinking: { type: 'disabled' } } : {}),
            messages: [{ role: 'system', content: instructions + (environment.AI_CHAT_JSON_MODE === 'true'
              ? '\n【JSON 接口约束】没有注册原生 tools 或 functions。工具动作必须写在任务要求的 JSON 字段中，由宿主读取。不得使用原生函数调用、functions.xxx 标记、特殊工具分隔符或 Markdown 围栏；只输出单个合法 JSON 对象。'
              : '') }, { role: 'user', content: input }] }),
          signal: requestSignal(signal, positiveInteger(timeoutMs, configuredTimeoutMs)),
        });
        if (!response.ok) {
          // Inspect only explicit context-limit codes, never surface provider
          // messages (which can contain input, endpoints or credentials).
          let code;
          if ([400,422].includes(response.status)) {
            const details = await response.json().catch(() => null);
            const contextCodes = ['context_length_exceeded', 'context_window_exceeded', 'max_context_length_exceeded'];
            if (contextCodes.includes(details?.error?.code) || contextCodes.includes(details?.error?.type)) code = 'input_too_large';
          }
          throw Object.assign(new Error(`Chat Completions API returned HTTP ${response.status}`), { status: response.status, ...(code ? { code } : {}) });
        }
        const data = await response.json();
        const choice = data?.choices?.[0];
        onMetadata?.(compactMetadata({ stopReason: choice?.finish_reason,
          inputTokens: data?.usage?.prompt_tokens,
          outputTokens: data?.usage?.completion_tokens,
          reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens ?? data?.usage?.reasoning_tokens,
          totalTokens: data?.usage?.total_tokens }));
        // Use only the protocol's final-answer field, never reasoning_content or
        // arbitrary JSON found in analysis. A cut-off answer cannot be all-clear.
        if (!Array.isArray(data?.choices) || data.choices.length !== 1 || choice?.finish_reason !== 'stop' ||
            choice.message?.role !== 'assistant' || choice.message.refusal || choice.message.tool_calls?.length ||
            typeof choice.message.content !== 'string' || !choice.message.content.trim()) {
          const reason = choice?.finish_reason === 'length' ? 'output_truncated'
            : choice?.message?.refusal || choice?.finish_reason === 'content_filter' ? 'response_refused'
            : choice?.finish_reason === 'stop' && typeof choice?.message?.content === 'string' && !choice.message.content.trim() ? 'empty_response'
            : 'response_protocol';
          throw Object.assign(new Error('Chat Completions returned no complete final answer'), { code: 'incomplete_response', reason });
        }
        return choice.message.content.trim();
      },
    };
  }

  const messagesUrl = anthropicMessagesUrl(baseUrl);
  const timeoutMs = positiveInteger(
    environment.AI_API_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );

  return {
    configured,
    format,
    insecureHttp,
    model,
    async generateReview({ instructions, input, maxOutputTokens, onMetadata, disableThinking = false, timeoutMs: requestTimeoutMs, signal }) {
      const response = await fetchImpl(messagesUrl, {
        method: "POST",
        headers: {
          "anthropic-version":
            environment.ANTHROPIC_VERSION || "2023-06-01",
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxOutputTokens,
          system: instructions,
          messages: [{ role: "user", content: input }],
          ...(disableThinking ? { thinking: { type: "disabled" } } : {}),
        }),
        signal: requestSignal(signal, positiveInteger(requestTimeoutMs, timeoutMs)),
      });

      if (!response.ok) {
        throw Object.assign(new Error(`Anthropic Messages API returned HTTP ${response.status}`), { status: response.status });
      }

      const data = await response.json();
      onMetadata?.(compactMetadata({ stopReason: data.stop_reason,
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
        textBlocks: (data.content || []).filter(b => b.type === 'text').length }));
      return (data.content || [])
        .filter(
          (block) =>
            block?.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join("\n\n");
    },
  };
}

function requestSignal(signal, durationMs) {
  const timeout = AbortSignal.timeout(durationMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function compactMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

export function anthropicMessagesUrl(baseUrl) {
  const url = new URL(baseUrl || DEFAULT_ANTHROPIC_BASE_URL);
  const path = url.pathname.replace(/\/+$/u, "");

  if (path.endsWith("/v1/messages")) {
    url.pathname = path;
  } else if (path.endsWith("/v1")) {
    url.pathname = `${path}/messages`;
  } else {
    url.pathname = `${path}/v1/messages`;
  }

  url.search = "";
  url.hash = "";
  return url.toString();
}

export function chatCompletionsUrl(baseUrl) {
  if (!baseUrl) throw new Error('AI_BASE_URL is required for openai-chat');
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/u, '');
  url.pathname = path.endsWith('/v1/chat/completions') ? path
    : path.endsWith('/v1') ? `${path}/chat/completions` : `${path}/v1/chat/completions`;
  url.search = ''; url.hash = '';
  return url.toString();
}

function normalizeFormat(value = "openai-responses") {
  const normalized = value.trim().toLowerCase();
  if (["openai", "responses", "openai-responses"].includes(normalized)) {
    return "openai-responses";
  }
  if (['openai-chat', 'chat-completions'].includes(normalized)) return 'openai-chat';
  if (
    ["anthropic", "messages", "anthropic-messages"].includes(normalized)
  ) {
    return "anthropic-messages";
  }
  throw new Error(`Unsupported AI_API_FORMAT: ${value}`);
}

function isInsecureHttp(baseUrl) {
  return Boolean(baseUrl && new URL(baseUrl).protocol === "http:");
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
