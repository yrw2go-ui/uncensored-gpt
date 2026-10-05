// OpenAI-compatible chat helpers shared by the routes.
export function providerKey(p) {
  return p.apiKeyEnv ? process.env[p.apiKeyEnv] : "none";
}

export function resolveProvider(providers, id) {
  const p = providers[id];
  if (!p) throw Object.assign(new Error("Unknown provider"), { status: 400 });
  const key = providerKey(p);
  if (!key) throw Object.assign(new Error(`Set ${p.apiKeyEnv} in companion/.env`), { status: 400 });
  return { ...p, key };
}

export function chatRequest(p, body, signal) {
  return fetch(`${p.baseURL}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
    body: JSON.stringify(body),
  });
}

/** Non-streaming call that expects a JSON object back. */
export async function chatJson(p, model, messages, { temperature = 0.7, maxTokens = 1500 } = {}) {
  const r = await chatRequest(p, { model, messages, temperature, max_tokens: maxTokens });
  if (!r.ok) throw Object.assign(new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`), { status: 502 });
  const data = await r.json();
  const text = (data.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw Object.assign(new Error("Model did not return JSON. Try another model."), { status: 502 });
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw Object.assign(new Error("Model returned invalid JSON. Try again or pick another model."), { status: 502 });
  }
}
