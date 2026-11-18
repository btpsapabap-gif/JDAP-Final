export function resolveAiProvider(requestedProvider, configuredModel, configuredProvider = configuredModel?.provider || "mock") {
  if (requestedProvider && !["mock", "openai", "ollama"].includes(requestedProvider)) {
    throw new Error("aiProvider must be 'mock', 'openai', or 'ollama'.");
  }
  if (requestedProvider && requestedProvider !== "mock" && requestedProvider !== configuredProvider) {
    throw new Error(`AI provider '${requestedProvider}' is not configured on this JDAP server.`);
  }
  const model = requestedProvider === "mock" ? null : configuredModel;
  return { model, provider: model ? configuredProvider : "mock" };
}
