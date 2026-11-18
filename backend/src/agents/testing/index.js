export default {
  id: "testing", name: "Test Engineer", specialty: "Quality assurance",
  description: "Creates unit, integration and regression test scenarios.",
  mockResponse: ({ prompt }) => {
    const billing = /billing|invoice|vbrk|vbrp/i.test(prompt) && /report|extract|header|item/i.test(prompt);
    return billing
      ? `Billing extraction test plan (draft):\n1. Run for an authorized sales organization and a narrow billing-date interval; compare document headers and items with VF03/VF05.\n2. Verify multiple invoices, multiple items, currencies, quantities and units; check header/item totals are not incorrectly aggregated.\n3. Verify an interval with no invoices returns an empty-result message.\n4. Verify missing date interval and missing sales organization are rejected by the selection screen.\n5. Verify a user without display authorization is denied.\n6. Test a high-volume interval in QA and agree a maximum date span or paging/ALV approach before production use.\n7. Regression-check totals and document counts against an approved standard report.\nNo tests were executed; validate field selection, authorization object and volume limits in the target ECC system.`
      : `Test plan:\n1. Positive case with valid master and transaction data.\n2. Missing/invalid mandatory input.\n3. Authorization-negative case.\n4. Boundary volume and performance case.\n5. Regression against existing output and totals.`;
  }
};
