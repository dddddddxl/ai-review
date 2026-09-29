import { createModelClient } from "../src/model-client.mjs";

const client = createModelClient();
if (!client.configured) {
  throw new Error("Model API is not configured");
}

const text = await client.generateReview({
  instructions: "Return a short plain-text acknowledgement.",
  input: "Reply with OK.",
  // Reasoning models share the output budget with analysis tokens.
  maxOutputTokens: 512,
  disableThinking: true,
});

if (!text) {
  throw new Error("Model API returned no text content");
}

console.log(
  JSON.stringify({
    status: "ok",
    apiFormat: client.format,
    model: client.model,
    responseCharacters: text.length,
  }),
);
