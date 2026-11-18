export default {
  id: "security", name: "Security Specialist", specialty: "Secure development",
  description: "Checks authorization, secrets, injection and data exposure risks.",
  mockResponse: () => `Security findings:\n- Enforce least-privilege authorization checks.\n- Validate all external inputs and avoid dynamic SQL injection.\n- Mask personal and financial data in logs.\n- Keep credentials outside source code and prompts.`
};
