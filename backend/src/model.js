export function createModel() {
  if ((process.env.AI_PROVIDER || "mock") !== "openai") return null;
  if (!process.env.OPENAI_API_KEY) throw new Error("AI_PROVIDER=openai but OPENAI_API_KEY is missing.");
  return {
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
