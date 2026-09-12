# Security Policy

## Supported versions

PromptSift is pre-1.0. Security fixes are provided for the latest release and the current `main` branch.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or accidental credential exposure.

Use the repository's **Security → Report a vulnerability** flow to submit a private report. Include the impact, a minimal reproduction, affected version or commit, suggested mitigation if known, and whether the issue has been disclosed elsewhere.

You should receive an acknowledgement within seven days. The maintainer will validate the report, coordinate a fix and release, and credit the reporter unless anonymity is requested.

## Scope priorities

Reports involving source-code exfiltration, sensitive-path bypasses, command parsing, hook-policy bypasses, unsafe file replacement, cache disclosure, or credential handling receive priority.

## Security model

PromptSift sends selected source text to the worker configured by the user. A remote worker is a trust boundary. The local endpoint is the privacy-preserving default, but users remain responsible for the model, endpoint, network, and retention policy they choose.
