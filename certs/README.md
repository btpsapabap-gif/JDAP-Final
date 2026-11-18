# SAP TLS trust certificate

Place the PEM-encoded issuing CA certificate, or an approved self-signed SAP server certificate, here as `sap-ca.pem` only when your Basis/security administrator provides it through an approved channel. Do not place private keys in this directory. The Compose backend mount is read-only. Configure `NODE_EXTRA_CA_CERTS=/run/certs/sap-ca.pem` in the local `.env` to enable it.
