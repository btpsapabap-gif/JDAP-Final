export function createModel() {
  const provider = (process.env.AI_PROVIDER || "mock").trim().toLowerCase();
  if (provider === "mock") return null;
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("AI_PROVIDER=openai but OPENAI_API_KEY is missing.");
    return {
      provider,
      async generate(prompt, agentId) {
        const response = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
            input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
            metadata: { application: "JDAP", agent: agentId }
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || `OpenAI request failed: ${response.status}`);
        const text = (data.output || []).flatMap(x => x.content || []).filter(x => x.type === "output_text").map(x => x.text).join("\n");
        return text || "Model returned no text output.";
      }
    };
  }
  if (provider === "ollama") {
    const baseUrl = (process.env.OLLAMA_BASE_URL || "").trim().replace(/\/+$/, "");
    const model = (process.env.OLLAMA_MODEL || "").trim();
    if (!baseUrl || !model) throw new Error("AI_PROVIDER=ollama requires OLLAMA_BASE_URL and OLLAMA_MODEL in .env.");
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw new Error("OLLAMA_BASE_URL must be a valid absolute URL."); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("OLLAMA_BASE_URL must use HTTP or HTTPS.");
    const configuredTimeout = Number(process.env.OLLAMA_TIMEOUT_MS) || 900_000;
    const timeoutMs = Math.max(30_000, Math.min(configuredTimeout, 900_000));
    const tokenLimit = (rawValue, fallback, ceiling) => Math.max(128, Math.min(Number(rawValue) || fallback, ceiling));
    return {
      provider,
      async generate(prompt, agentId) {
        const isAbap = agentId === "abap";
        const maxTokens = isAbap
          ? tokenLimit(process.env.OLLAMA_ABAP_MAX_TOKENS, 1800, 4096)
          : tokenLimit(process.env.OLLAMA_MAX_TOKENS, 512, 2048);
        let response;
        try {
          response = await fetch(baseUrl + "/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              stream: false,
              max_tokens: maxTokens,
              messages: [
                {
                  role: "system",
                  content: isAbap
                    ? "You are JDAP's ABAP specialist. Return a concise, complete ABAP draft for the task, without markdown fences. Keep code focused; do not add unrelated sections. Clearly mark assumptions as ABAP comments. Never claim SAP execution."
                    : "You are a focused JDAP SAP specialist. Do not write ABAP or other source code. Answer only for your specialty in compact, actionable bullets, at most 180 words. Avoid generic introductions and repeated task text. Clearly mark assumptions and Clean Core/API release uncertainties. Never claim SAP execution."
                },
                { role: "user", content: prompt }
              ]
            }),
            signal: AbortSignal.timeout(timeoutMs)
          });
        } catch (error) {
          if (error?.name === "TimeoutError" || error?.name === "AbortError") {
            throw new Error(`Ollama timed out after ${Math.round(timeoutMs / 1000)} seconds while the ${agentId} agent was generating. The workflow stopped without switching providers.`);
          }
          throw error;
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || `Ollama request failed: ${response.status}`);
        const text = data.choices?.[0]?.message?.content;
        return typeof text === "string" && text.trim() ? text : "Ollama returned no text output.";
      }
    };
  }
  throw new Error(`Unsupported AI_PROVIDER: ${provider}. Use mock, openai, or ollama.`);
}
