export default {
  id: "review", name: "Code Reviewer", specialty: "Code quality",
  description: "Reviews source drafts for maintainability, performance and correctness risks.",
  mockResponse: ({ prompt }) => {
    const billing = /billing|invoice|vbrk|vbrp/i.test(prompt) && /report|extract|header|item/i.test(prompt);
    return billing
      ? `Review findings for the billing extraction draft:\n- Uses an explicit VBRK/VBRP field list and requires sales organization plus billing-date selection to reduce accidental broad reads.\n- Checks display authorization before reading billing data; verify V_VBRK_VKO and required fields with the target system's SU21/PFCG configuration.\n- Header and item totals are displayed at their own levels; do not sum header totals across item rows.\n- The draft uses classic Open SQL patterns intended for ECC, but exact syntax, authorization behavior, output usability and runtime still require target-system validation.\n- Add an agreed maximum interval or ALV/paging strategy after measuring expected data volume.`
      : `Review findings:\n- Draft scaffold is not production-ready.\n- Add explicit types, exception handling and authorization checks.\n- Avoid SELECT * and unbounded data reads.\n- Validate syntax and performance using target-system tools.`;
  }
};
