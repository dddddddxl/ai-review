import { AsyncLocalStorage } from 'node:async_hooks';

const usageContext = new AsyncLocalStorage();

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function addCount(left, right) {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function normalizedUsage(value = {}) {
  return {
    requests: tokenCount(value.requests),
    inputTokens: tokenCount(value.inputTokens),
    outputTokens: tokenCount(value.outputTokens),
    reasoningTokens: tokenCount(value.reasoningTokens),
    totalTokens: tokenCount(value.totalTokens),
  };
}

function recordUsage(target, metadata = {}) {
  const inputTokens = tokenCount(metadata.inputTokens);
  const outputTokens = tokenCount(metadata.outputTokens);
  const reportedTotal = tokenCount(metadata.totalTokens);
  target.requests = addCount(target.requests, 1);
  target.inputTokens = addCount(target.inputTokens, inputTokens);
  target.outputTokens = addCount(target.outputTokens, outputTokens);
  target.reasoningTokens = addCount(target.reasoningTokens, tokenCount(metadata.reasoningTokens));
  target.totalTokens = addCount(target.totalTokens, reportedTotal || addCount(inputTokens, outputTokens));
}

export function createModelUsageMeter(client) {
  const meteredClient = {
    ...client,
    async generateReview(options = {}) {
      const current = usageContext.getStore();
      const originalMetadata = options.onMetadata;
      return client.generateReview({
        ...options,
        onMetadata(metadata) {
          if (current) recordUsage(current, metadata);
          originalMetadata?.(metadata);
        },
      });
    },
  };

  return {
    client: meteredClient,
    createScope(previousUsage) {
      const usage = normalizedUsage(previousUsage);
      return {
        run(task) { return usageContext.run(usage, task); },
        snapshot() { return { ...usage }; },
      };
    },
  };
}

export function hasReportedUsage(usage) {
  return tokenCount(usage?.requests) > 0;
}
