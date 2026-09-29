import { createModelClient } from '../src/model-client.mjs';
import { PR_INSTRUCTIONS, CI_INSTRUCTIONS, renderPrReview, renderCiAnalysis, generateTemplateReview } from '../src/review-templates.mjs';
const client = createModelClient();
for (const kind of ['pr', 'ci']) {
  const render = text => kind === 'pr' ? renderPrReview(text, { files: [{ filename: 'docs/example.md' }], includedFiles: 1 }) : renderCiAnalysis(text);
  const text = await generateTemplateReview(client, {
    instructions: kind === 'pr' ? PR_INSTRUCTIONS : CI_INSTRUCTIONS,
    input: kind === 'pr' ? 'Synthetic test. FILE: docs/example.md\n@@ -1 +1 @@\n-# Guide\n+# User guide\n仅标题澄清，无代码变更。' : 'Synthetic test. Workflow failed. Job: lint. 日志下载失败，未取得错误内容。PR仅修改文档标题。',
    maxOutputTokens: 2000,
    validate: text => !render(text).includes('模型未返回符合模板'),
  });
  const body = kind === 'pr' ? renderPrReview(text, { files: [{ filename: 'docs/example.md' }], includedFiles: 1 }) : renderCiAnalysis(text);
  if (body.includes('模型未返回符合模板')) {
    console.log(JSON.stringify({ kind, syntheticResponse: text }));
    throw new Error(`Template validation failed: ${kind}`);
  }
  console.log(JSON.stringify({ kind, status: 'ok', body }));
}
