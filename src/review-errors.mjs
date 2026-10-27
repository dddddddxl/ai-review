// Only allowlisted categories cross the diagnostic/publication boundary.
// Never expose provider bodies, exception messages, endpoints or credentials.
export function reviewErrorCode(error) {
  if (error?.code === 'incomplete_response' && ['output_truncated', 'empty_response', 'response_refused', 'response_protocol'].includes(error.reason)) return error.reason;
  if (['ci_schema_invalid', 'ci_evidence_invalid', 'snapshot_changed', 'review_deadline',
    'native_tools_unavailable', 'invalid_tool_response', 'evidence_budget', 'evidence_unavailable', 'evidence_incomplete'].includes(error?.code)) return error.code;
  if (['TimeoutError', 'APIConnectionTimeoutError'].includes(error?.name) || error?.code === 'ETIMEDOUT') return 'timeout';
  if (error?.status === 401 || error?.status === 403) return 'authentication';
  if (error?.status === 429) return 'rate_limit';
  if (error?.status === 413 || error?.code === 'input_too_large') return 'input_too_large';
  if (error?.code === 'incomplete_response' || error instanceof SyntaxError) return 'invalid_response';
  return 'model_error';
}

export function reviewFailureLabel(code) {
  return ({ output_truncated: '模型输出达到长度上限，最终结果被截断', empty_response: '模型最终回答为空',
    response_refused: '模型拒绝回答或内容被接口拦截', response_protocol: '模型响应不符合约定协议',
    ci_schema_invalid: '模型返回的 JSON 或必填字段不符合 CI 格式', ci_evidence_invalid: '模型引用无法与本批日志逐字核对',
    snapshot_changed: 'PR 或工作流版本已变化，停止当前分析',
    review_deadline: '本轮审查已达到时间预算，进度已保留',
    native_tools_unavailable: '模型接口未提供所需的只读工具能力', invalid_tool_response: '模型工具调用协议未完成',
    evidence_budget: '本轮取证达到限额，仍有未决范围', evidence_unavailable: '固定版本源码暂不可用',
    evidence_incomplete: '关键调用契约或审查范围尚未核实完整',
    timeout: '模型请求超时', authentication: '模型鉴权或权限失败', rate_limit: '模型接口限流',
    input_too_large: '输入超过模型接口限制', invalid_response: '模型未返回完整、有效的审查格式',
    model_error: '模型调用失败', verification_unavailable: '候选问题复核失败' })[code] || '审查未完成';
}
