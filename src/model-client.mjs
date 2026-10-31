import OpenAI from "openai";
import { createHash } from 'node:crypto';

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
      async generateReview({ instructions, input, maxOutputTokens, onMetadata, timeoutMs, deadlineAt, signal }) {
        const requestMs = boundedTimeout(timeoutMs, configuredTimeoutMs, deadlineAt, signal);
        const response = await client.responses.create({
          model,
          store: false,
          max_output_tokens: maxOutputTokens,
          instructions,
          input,
        }, { timeout: requestMs, ...(signal ? { signal } : {}) });
        onMetadata?.(compactMetadata({ status: response.status,
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          totalTokens: response.usage?.total_tokens }));
        return response.output_text?.trim() || "";
      },
    };
  }

  if (format === 'openai-chat') {
    const thinkingProtocol = environment.AI_THINKING_PROTOCOL || (/^glm(?:-|[0-9])/i.test(model) ? 'glm' : 'none');
    if (!['glm', 'none'].includes(thinkingProtocol)) throw new Error('Invalid AI_THINKING_PROTOCOL');
    const thinkingFields = disabled => thinkingProtocol === 'glm' ? { thinking: { type: disabled ? 'disabled' : 'enabled' } } : {};
    const endpoint = chatCompletionsUrl(baseUrl);
    const configuredTimeoutMs = positiveInteger(environment.AI_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    // Reasoning models can think for many minutes. When streaming, a request is
    // only abandoned after it stops producing tokens, or at a generous hard cap.
    const stream = environment.AI_STREAM === 'true';
    const idleTimeoutMs = positiveInteger(environment.AI_STREAM_IDLE_TIMEOUT_MS, 90_000);
    const streamMaxMs = positiveInteger(environment.AI_STREAM_MAX_MS, 1_200_000);
    return {
      configured, format, insecureHttp, model, stream, thinkingProtocol, requestTimeoutMs: stream ? streamMaxMs : configuredTimeoutMs,
      // Opt-in native tool turns. Ordinary review decoding remains unchanged.
      async generateToolTurn({ instructions, messages, tools, toolChoice = 'auto', maxOutputTokens, disableThinking = false,
        onMetadata, onToolDelta, parallelToolCalls, timeoutMs, deadlineAt, signal }) {
        const requestMs = boundedTimeout(stream ? Math.min(streamMaxMs, positiveInteger(timeoutMs, streamMaxMs)) : timeoutMs,
          configuredTimeoutMs, deadlineAt, signal);
        const controller = new AbortController();
        const expire = message => controller.abort(new DOMException(message, 'TimeoutError'));
        const hardTimer = setTimeout(() => expire('request exceeded its time limit'), requestMs);
        let idleTimer;
        const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => expire('stream went idle'), idleTimeoutMs); };
        try {
          if (stream) touch();
          const response = await fetchImpl(endpoint, { method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model, stream, ...(stream ? { stream_options: { include_usage: true } } : {}),
              ...thinkingFields(disableThinking),
              ...(typeof parallelToolCalls === 'boolean' ? {parallel_tool_calls:parallelToolCalls} : {}),
              max_tokens: maxOutputTokens, messages: [{ role: 'system', content: instructions }, ...messages], tools, tool_choice: toolChoice }),
            signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal });
          if (!response.ok) throw Object.assign(new Error(`Native tool API returned HTTP ${response.status}`), { code: 'native_tool_http_error', status: response.status });
          const data = stream ? await readChatStream(response, touch, onToolDelta) : await response.json();
          const choice = data?.choices?.[0], message = choice?.message;
          const metadata = compactMetadata({ stopReason: choice?.finish_reason, inputTokens: data?.usage?.prompt_tokens,
            outputTokens: data?.usage?.completion_tokens, totalTokens: data?.usage?.total_tokens,
            reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens ?? data?.usage?.reasoning_tokens });
          onMetadata?.(metadata);
          if (data?.choices?.length !== 1 || message?.role !== 'assistant' || message.refusal ||
              !['stop', 'tool_calls'].includes(choice.finish_reason))
            throw Object.assign(new Error('Incomplete native tool response'), { code: 'incomplete_tool_response',
              reason: choice?.finish_reason === 'length' ? 'output_truncated' : 'response_protocol' });
          const calls = message.tool_calls || [], ids = new Set();
          for (const call of calls) {
            if (typeof call.id !== 'string' || ids.has(call.id) || call.type !== 'function' ||
                typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string')
              throw Object.assign(new Error('Invalid native tool response'), { code: 'invalid_tool_response' });
            ids.add(call.id);
          }
          // Reasoning can be replayed in memory if the provider requires it for
          // tool continuation; callers must never serialize this whole message.
          return { message, metadata };
        } finally { clearTimeout(hardTimer); clearTimeout(idleTimer); }
      },
      async generateReview({ instructions, input, maxOutputTokens, onMetadata, onReasoning, disableThinking = false, timeoutMs, deadlineAt, signal }) {
        const requestMs = boundedTimeout(stream ? Math.min(streamMaxMs, positiveInteger(timeoutMs, streamMaxMs)) : timeoutMs,
          configuredTimeoutMs, deadlineAt, signal);
        const controller = new AbortController();
        const expire = message => controller.abort(new DOMException(message, 'TimeoutError'));
        const hardTimer = setTimeout(() => expire('request exceeded its time limit'), requestMs);
        let idleTimer = null;
        const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => expire('stream went idle'), idleTimeoutMs); };
        try {
          if (stream) touch();
          const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), max_tokens: maxOutputTokens,
              ...thinkingFields(disableThinking),
              messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }] }),
            signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
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
          const data = stream ? await readChatStream(response, touch) : await response.json();
          const choice = data?.choices?.[0];
          onMetadata?.(compactMetadata({ stopReason: choice?.finish_reason,
            inputTokens: data?.usage?.prompt_tokens,
            outputTokens: data?.usage?.completion_tokens,
            reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens ?? data?.usage?.reasoning_tokens,
            totalTokens: data?.usage?.total_tokens }));
          const reasoning = choice?.message?.reasoning_content;
          if (typeof reasoning === 'string' && reasoning) onReasoning?.(reasoning);
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
        } finally {
          clearTimeout(hardTimer);
          clearTimeout(idleTimer);
        }
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
    async generateReview({ instructions, input, maxOutputTokens, onMetadata, disableThinking = false, timeoutMs: requestTimeoutMs, deadlineAt, signal }) {
      const requestSignal = AbortSignal.timeout(boundedTimeout(requestTimeoutMs, timeoutMs, deadlineAt, signal));
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
        signal: signal ? AbortSignal.any([requestSignal, signal]) : requestSignal,
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

function compactMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

// Reassemble an OpenAI-compatible SSE stream into the non-streaming response
// shape, so validation stays identical. `touch` is called for every event.
async function readChatStream(response, touch, onToolDelta) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const choices = new Map();
  let buffer = '', usage, sawDone = false;
  const handle = line => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { sawDone = true; return; }
    const event = JSON.parse(payload);
    // Never surface provider error text: it can echo input or endpoints.
    if (event?.error) throw Object.assign(new Error('Chat Completions stream reported an error'), { code: 'stream_error' });
    if (event?.usage) usage = event.usage;
    for (const delta of event?.choices || []) {
      const index = Number.isInteger(delta.index) ? delta.index : 0;
      const choice = choices.get(index) || { index, finish_reason: null, message: { role: undefined, content: '', reasoning_content: '' } };
      const part = delta.delta || {};
      if (part.role) choice.message.role = part.role;
      if (typeof part.content === 'string') choice.message.content += part.content;
      if (typeof part.reasoning_content === 'string') choice.message.reasoning_content += part.reasoning_content;
      if (part.refusal) choice.message.refusal = `${choice.message.refusal || ''}${part.refusal}`;
      if (part.tool_calls?.length) {
        const calls = choice.message.tool_calls ||= [];
        for (const fragment of part.tool_calls) {
          // Opt-in protocol diagnostics only: no argument values, content,
          // reasoning or headers leave this callback, even across split tokens.
          const digest = value => createHash('sha256').update(String(value)).digest('hex');
          onToolDelta?.({ choiceIndex: index, toolIndex: fragment.index ?? null,
            idHash: fragment.id ? digest(fragment.id) : null,
            nameHash: fragment.function?.name ? digest(fragment.function.name) : null,
            argumentsChars: fragment.function?.arguments?.length ?? 0,
            argumentsHash: typeof fragment.function?.arguments === 'string' ? digest(fragment.function.arguments) : null });
          // Never merge ambiguous/missing indices or two call IDs into one JSON
          // object. Failing closed here keeps duplicate-key diagnosis meaningful.
          const at = fragment.index;
          if (!Number.isSafeInteger(at) || at < 0 || at >= 16 ||
              (fragment.id && calls[at]?.id && fragment.id !== calls[at].id))
            throw Object.assign(new Error('Ambiguous stream tool identity'), {code:'invalid_tool_response',reason:'stream_tool_identity'});
          const call = calls[at] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (fragment.id) call.id = fragment.id;
          if (fragment.type) call.type = fragment.type;
          if (fragment.function?.name) call.function.name += fragment.function.name;
          if (typeof fragment.function?.arguments === 'string') call.function.arguments += fragment.function.arguments;
        }
      }
      if (delta.finish_reason) choice.finish_reason = delta.finish_reason;
      choices.set(index, choice);
    }
  };
  try { for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    touch();
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handle(line);
    }
  } } catch (error) { await reader.cancel().catch(()=>{}); throw error; }
  buffer += decoder.decode();
  if (buffer.trim()) handle(buffer.trim());
  // A stream that ends without [DONE] or a finish reason is cut off, never complete.
  const ordered = [...choices.values()].sort((a, b) => a.index - b.index);
  if (!sawDone && !ordered.some(choice => choice.finish_reason)) {
    throw Object.assign(new Error('Chat Completions stream ended early'), { code: 'incomplete_response', reason: 'response_protocol' });
  }
  return { choices: ordered, usage };
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

// Called after any global model semaphore wait, so queued requests cannot use
// a stale timeout allowance or contact the provider after the review expired.
function boundedTimeout(value, fallback, deadlineAt, signal) {
  signal?.throwIfAborted();
  const timeoutMs = positiveInteger(value, fallback);
  if (!Number.isFinite(deadlineAt)) return timeoutMs;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw Object.assign(new Error('Review time budget exhausted'), { code: 'review_deadline' });
  return Math.max(1, Math.min(timeoutMs, remaining));
}
