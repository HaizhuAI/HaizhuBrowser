# Security Audit — sheying2013/OpenBrowser (reference project)

Audit date: 2025-07. Scope: `Browserapp/` cloned to `_analysis/OpenBrowser` @ v1.0.28.
Trigger: upstream author involved in a credential-theft incident (NodeLoc warning);
project used as fingerprint-browser reference only, never executed.

## Method

Static review only (REA MCP unavailable — tool listing failed). Coverage:

- All URL literals repo-wide (`grep` for http(s), IP literals, metadata endpoints)
- `automation/cloud-sync.js` — WebDAV/GitHub/local sync provider egress
- `automation/proxy-providers*.js` — upstream proxy fetching + SSRF guards
- `automation/local-api-server.js`, `mcp-server.js`, `api-key.js` — localhost attack surface
- `automation/credential-crypto.js`, `log-sanitizer.js` — secret handling
- `automation/fingerprint.js`, `device-personas.js`, `fingerprint-pool.js` — reuse targets
- `engine.js`, `isolation.js` — profile/data-root isolation
- Startup hooks, env-var reads, home-directory paths, update/crash-report paths

## Findings

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| F1 | `169.254.169.254`, `100.100.100.200` cloud-metadata literals | **False positive — test fixture** | Only in `proxy-providers-selftest.js`, asserting these are *blocked* (SSRF guard) |
| F2 | `cloud-sync.js` egress | **User-configured only** | WebDAV requires HTTPS unless loopback; GitHub via user-provided token; local provider. No hardcoded upload host |
| F3 | Local API / MCP servers | **Authenticated** | API-key required; binds loopback; log sanitizer strips secrets |
| F4 | Env/home-dir reads | **Isolated** | `isolation.js` confines browser data roots; no `.ssh`/wallet/cookie harvesting found |
| F5 | Telemetry / update / crash-report | **None found** | No silent beacon; crash URL sanitized |
| F6 | Hardcoded exfiltration domain | **None found** | All suspicious URLs resolve to self-tests or user config |

**Residual risk:** static review cannot exclude obfuscated runtime behavior (native binaries,
remote-loaded scripts). Conclusion: source is *audit-clean at this revision*, but we copy
**no code verbatim** — only factual data tables — so upstream runtime risk does not transfer.

## License

`Browserapp/LICENSE.chrome-power.txt` = **AGPL-3.0**. Verbatim code reuse would
copyleft HaizhuBrowser under AGPL. Policy adopted:

- **Rejected for copy:** all function implementations (`fingerprint.js` logic,
  `cloud-sync.js`, API/MCP servers, isolation, sanitizer).
- **Adopted:** factual data only — Chromium GPU renderer strings, stock OS font
  lists, system speech-voice names, media-device labels, locale/timezone presets,
  GPU-class WebGL parameter limits. These are vendor-published facts, re-expressed
  in our own module structure.
- Provenance recorded here + `THIRD-PARTY-NOTICES.md`.

## What was adapted into HaizhuBrowser (v1.5.0)

Concepts (re-implemented, not copied):

1. **Coherent device personas** — CPU/mem/GPU/screen/DPR/colorDepth bundled as one
   real machine; per-profile seed → stable identity; host-WebGL-limit compat check.
2. **GPU-class GL parameter tables** — NVIDIA/AMD/Intel/Apple/Qualcomm/ARM limits
   for `getParameter` coherence.
3. **OS-scoped pools** — speech voices, media device labels, stock fonts,
   locale/timezone presets (no cross-OS leakage).
4. **Site-aware noise stability** — high-risk hosts get near-zero canvas delta.
5. **Seed-derived sub-surfaces** — battery, deviceName, ICE local IP, media deviceIds.

## Rejected outright

- `cloud-sync.js` (network egress surface — we ship zero sync)
- `local-api-server.js` / `mcp-server.js` (unneeded attack surface)
- `.crx` bundled extension binaries (opaque)
- Any `fetch`/WS code path — our modules contain no network code at all
