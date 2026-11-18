const LABELS_BY_NAME = new Map([
  ["S_FKDAT", "Billing date"],
  ["S_VBELN", "Billing document number"],
  ["S_KUNAG", "Sold-to party"],
  ["P_VKORG", "Sales organization"],
  ["P_BUKRS", "Company code"],
  ["P_EKORG", "Purchasing organization"],
  ["S_BEDAT", "Purchase order date"],
  ["S_EBELN", "Purchase order"],
  ["S_PO", "Purchase order"],
  ["S_EKGRP", "Purchasing group"],
  ["S_BSART", "Purchase order type"],
  ["S_LIFNR", "Supplier"],
  ["S_MATNR", "Material"],
  ["S_WERKS", "Plant"],
  ["S_LGORT", "Storage location"],
  ["S_BUKRS", "Company code"],
  ["S_GJAHR", "Fiscal year"],
  ["S_BELNR", "Accounting document"],
  ["S_BUDAT", "Posting date"],
  ["S_HKONT", "G/L account"],
  ["S_KOSTL", "Cost center"],
  ["S_PRCTR", "Profit center"],
  ["S_KUNNR", "Customer"]
]);

const LABELS_BY_TOKEN = new Map([
  ["bukrs", "Company code"], ["company", "Company"], ["code", "code"],
  ["ekorg", "Purchasing organization"], ["purchasing", "Purchasing"], ["org", "organization"],
  ["bedat", "Purchase order date"], ["ebeln", "Purchase order"], ["ebelp", "Purchase order item"], ["po", "Purchase order"], ["ekgrp", "Purchasing group"], ["bsart", "Purchase order type"],
  ["lifnr", "Supplier"], ["supplier", "Supplier"], ["matnr", "Material"], ["material", "Material"],
  ["werks", "Plant"], ["plant", "Plant"], ["lgort", "Storage location"], ["fkdat", "Billing date"], ["vbeln", "Billing document"],
  ["kunag", "Sold-to party"], ["vkorg", "Sales organization"], ["gjahr", "Fiscal year"], ["belnr", "Accounting document"], ["budat", "Posting date"], ["hkont", "G/L account"], ["kostl", "Cost center"], ["prctr", "Profit center"], ["kunnr", "Customer"], ["date", "Date"], ["from", "From"],
  ["to", "To"], ["number", "Number"], ["document", "Document"], ["item", "Item"],
  ["group", "Group"], ["type", "Type"], ["customer", "Customer"], ["account", "Account"],
  ["posting", "Posting"], ["fiscal", "Fiscal"], ["year", "year"], ["period", "Period"],
  ["cost", "Cost"], ["center", "Center"], ["profit", "Profit"], ["asset", "Asset"],
  ["gl", "G/L"], ["currency", "Currency"], ["status", "Status"]
]);

function labelFromIdentifier(name) {
  const key = String(name || "").toUpperCase();
  if (LABELS_BY_NAME.has(key)) return LABELS_BY_NAME.get(key);
  const parts = key.replace(/^[SP]_/, "").toLowerCase().split(/_+/).filter(Boolean);
  if (!parts.length) return null;
  const mapped = parts.map(part => LABELS_BY_TOKEN.get(part));
  if (mapped.some(part => !part)) return null;
  const words = mapped.join(" ").replace(/\s+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : null;
}

/** Return declared selection IDs and their source lines. */
export function selectionScreenDeclarations(source = "") {
  const code = String(source)
    .replace(/^\s*\*.*$/gm, "")
    .replace(/^\s*".*$/gm, "");
  const declarations = [];
  const seen = new Set();
  const statements = code.matchAll(/^\s*(?:SELECT-OPTIONS|PARAMETERS)\b([\s\S]*?\.)/gim);
  for (const match of statements) {
    const declaration = match[1].trim();
    const chained = declaration.startsWith(":");
    const body = chained ? declaration.slice(1) : declaration;
    const segments = chained ? body.split(",") : [body];
    for (const segment of segments) {
      const name = segment.trim().match(/^([A-Z][A-Z0-9_]*)\b/i)?.[1]?.toUpperCase();
      if (!name || seen.has(name)) continue;
      const before = code.slice(0, match.index + match[0].indexOf(match[1]));
      const line = before.split("\n").length;
      declarations.push({ name, line });
      seen.add(name);
    }
  }
  return declarations;
}

/** Derive reviewable labels from actual PARAMETERS / SELECT-OPTIONS declarations. */
export function deriveSelectionTexts(source = "") {
  return selectionScreenDeclarations(source).flatMap(({ name }) => {
    // SAP selection-screen IDs are limited to eight characters.
    if (name.length > 8) return [];
    const text = labelFromIdentifier(name);
    return text && text.length <= 30 ? [[name, text]] : [];
  });
}
