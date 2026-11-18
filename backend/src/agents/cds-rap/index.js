export default {
  id: "cds-rap", name: "CDS / RAP Developer", specialty: "Data modeling",
  description: "Drafts CDS entities, RAP behavior and service definitions.",
  mockResponse: () => `CDS/RAP design draft:\n- Define a CDS view entity over verified source entities.\n- Use explicit field lists and authorization annotations.\n- Add behavior definitions only for transactional requirements.\n- Publish through a service definition and binding where supported.`
};
