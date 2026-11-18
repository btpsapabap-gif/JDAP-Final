INSERT INTO projects (name, description)
SELECT 'JDAP Demo Project', 'Local mock-first SAP developer agent demonstration'
WHERE NOT EXISTS (SELECT 1 FROM projects WHERE name = 'JDAP Demo Project');

INSERT INTO sap_systems (id,name,system_type,release,mode) VALUES
('mock-ecc','ECC Development (Mock)','ECC','ECC 6.0','MOCK'),
('mock-s4','S/4HANA Development (Mock)','S4HANA','S/4HANA 2023','MOCK'),
('mock-btp','SAP BTP Subaccount (Mock)','BTP','BTP Cloud Foundry','MOCK')
ON CONFLICT (id) DO NOTHING;
