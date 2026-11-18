export default {
  id: "compatibility", name: "Release Compatibility Specialist", specialty: "ECC / S4 compatibility",
  description: "Flags release-sensitive syntax and migration compatibility considerations.",
  mockResponse: ({ system }) => `Compatibility notes for ${system?.release||"unknown release"}:\n- Verify syntax support and API release status in the actual system.\n- Prefer released interfaces for S/4HANA Cloud.\n- Treat ECC and S/4HANA data model differences explicitly.\n- This is a static mock assessment, not a simplification check.`
};
