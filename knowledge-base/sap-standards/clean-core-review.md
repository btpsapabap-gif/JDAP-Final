---
id: sap-clean-core-review
title: Clean Core review evidence
summary: Record target-system evidence for released APIs, extension points, and ATC findings without overstating offline checks.
tags: clean-core, atc, review, governance
sourceName: JDAP working guidance
updated: 2026-11-16
workflowApproved: true
---

## Evidence to attach to an ABAP review

Record one or more evidence items that match the implementation:

- Target SAP system and release, ATC check variant, date, findings, and finding disposition.
- Released API or CDS entity used, with its release state confirmed in that target system.
- Released extension point or extensibility mechanism used, with the target-system evidence.
- Authorization and data-access review when the change reads or changes business data.

## What JDAP can and cannot conclude

JDAP can help organize the evidence and run local source checks. Offline grammar and heuristic checks cannot assign a Clean Core level or prove compliance. The target system's supported checks and the reviewer's evidence determine the outcome.

If evidence is missing, keep the review open and state what target-system check or design confirmation is still needed.
