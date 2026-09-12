function endpoint(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function extractText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text ?? "").join("");
  }
  throw new Error("The worker returned no text in choices[0].message.content");
}

export async function chat(config, { system, user }) {
  const apiKey = process.env[config.provider.apiKeyEnv];
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetch(endpoint(config.provider.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.provider.model,
        temperature: config.provider.temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });
  } catch (error) {
    if (error?.name === "TimeoutError") {
      throw new Error(`Worker timed out after ${config.requestTimeoutMs} ms`);
    }
    throw new Error(`Cannot reach worker at ${config.provider.baseUrl}: ${error.message}`);
  }

  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }

  if (!response.ok) {
    const detail = body?.error?.message ?? raw.slice(0, 500) ?? response.statusText;
    throw new Error(`Worker request failed (${response.status}): ${detail}`);
  }

  const text = extractText(body);
  if (!text.trim()) throw new Error("The worker returned an empty response");
  return {
    text,
    usage: {
      inputTokens: body?.usage?.prompt_tokens ?? body?.usage?.input_tokens ?? null,
      outputTokens: body?.usage?.completion_tokens ?? body?.usage?.output_tokens ?? null
    }
  };
}

export async function probe(config) {
  const apiKey = process.env[config.provider.apiKeyEnv];
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  try {
    const response = await fetch(`${config.provider.baseUrl.replace(/\/+$/, "")}/models`, {
      headers,
      signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, 5_000))
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
