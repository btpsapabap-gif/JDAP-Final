import abaplint from "@abaplint/core";

const { Config, MemoryFile, Registry, versionToABAPRelease } = abaplint;

const SUPPORTED_RELEASES = new Set([
  "v702", "v740sp02", "v740sp05", "v740sp08", "v750", "v751", "v752", "v753", "v754", "v755", "v756", "v757", "v758"
]);

export function checkAbapGrammar(source, release = "v750") {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("ABAP source is required.");
  }
  if (source.length > 200_000) {
    throw new Error("ABAP source exceeds the 200,000 character limit.");
  }
  if (!SUPPORTED_RELEASES.has(release)) {
    throw new Error("Unsupported ABAP release. Select a supported on-premise release.");
  }

  const filename = "/src/zjdap_syntax_check.prog.abap";
  const abapRelease = versionToABAPRelease(release);
  const defaults = Config.getDefault({ release: abapRelease.name, language: "Normal" }).get();
  const config = new Config(JSON.stringify({ ...defaults, dependencies: [], rules: { parser_error: true } }));
  const registry = new Registry(config);
  registry.addFile(new MemoryFile(filename, source));
  const issues = registry.findIssues().map(issue => ({
    line: issue.getStart().getRow(),
    column: issue.getStart().getCol(),
    message: issue.getMessage(),
    severity: String(issue.getSeverity()).toLowerCase()
  }));

  return {
    state: issues.length ? "syntax-issues" : "grammar-ok",
    engine: "abaplint",
    release,
    lineCount: source.split(/\r?\n/).length,
    issues,
    message: issues.length
      ? `The ABAP 7.50 grammar check found ${issues.length} issue(s). Review them in the editor.`
      : `No grammar issues found for ${release}. This is an offline parser check, not SAP activation or DDIC validation.`
  };
}
