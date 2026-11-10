# Architecture decision records

One short record per major decision. To change a decision in `docs/PLAN.md`, add a new ADR that supersedes the old one; do not edit history.

| #                                                      | Title                                                                                 | Status   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------- |
| [0001](0001-stack.md)                                  | Runtime and stack                                                                     | Accepted |
| [0002](0002-generated-operation-registry.md)           | Generated operation registry and vendored spec                                        | Accepted |
| [0003](0003-lk-access-through-governor.md)             | All LegendKeeper traffic goes through the governor                                    | Accepted |
| [0004](0004-mcp-sdk-v2.md)                             | MCP SDK: v2 split packages                                                            | Accepted |
| [0005](0005-meta-tool-mcp-surface.md)                  | Low-level API behind meta-tools                                                       | Accepted |
| [0006](0006-mcp-sdk-v2-confirmed-for-transport.md)     | MCP SDK v2 confirmed for the transport, with our own auth gate                        | Accepted |
| [0007](0007-oauth-authorization-server-design.md)      | OAuth authorization server design choices                                             | Accepted |
| [0008](0008-chatgpt-as-a-client.md)                    | ChatGPT as a supported client                                                         | Accepted |
| [0009](0009-refresh-token-grace-window.md)             | Refresh-token grace window                                                            | Accepted |
| [0010](0010-job-engine-verification-and-holds.md)      | Job engine verification, `uncertain` steps and write holds                            | Accepted |
| [0011](0011-tool-layer.md)                             | The MCP tool layer, stored results and the upload job                                 | Accepted |
| [0012](0012-live-policy-evaluation.md)                 | Policy attaches to profiles and is evaluated live                                     | Accepted |
| [0013](0013-dashboard-and-admin-api.md)                | Dashboard, admin API and live stream                                                  | Accepted |
| [0014](0014-auth-pages-referrer-policy.md)             | Sign-in, consent and sign-out pages use `same-origin` referrers                       | Accepted |
| [0015](0015-deployment-layout.md)                      | Deployment layout on the shared server                                                | Accepted |
| [0016](0016-maintenance-and-mappings-choices.md)       | Maintenance scheduler and mappings: interpretation choices                            | Accepted |
| [0017](0017-unsupported-client-grant-types-ignored.md) | Grant types the bridge does not issue are ignored, not refused                        | Accepted |
| [0018](0018-chunk-8-hardening-decisions.md)            | Chunk 8 hardening decisions                                                           | Accepted |
| [0019](0019-consent-keeps-existing-scope.md)           | Consent keeps an existing profile's scope                                             | Accepted |
| [0020](0020-separate-build-user.md)                    | A separate build user; deploy as root, one user per step                              | Accepted |
| [0021](0021-private-key-jwt-client-authentication.md)  | private_key_jwt client authentication for metadata-document clients                   | Accepted |
| [0022](0022-markdown-converter.md)                     | The Markdown converter (v2 session B1)                                                | Accepted |
| [0023](0023-project-model.md)                          | Several LegendKeeper projects in one bridge; exactly one bridge process per project   | Accepted |
| [0024](0024-env-sync.md)                               | env-sync keeps the env file in step with the template; the deploy checks itself first | Accepted |
| [0025](0025-repository-tree.md)                        | The repository tree: observation order, per-project serialisation                     | Accepted |
| [0026](0026-type-registry-and-name-resolution.md)      | The type registry and taxonomy, name resolution, ordering and character placement     | Accepted |
| [0027](0027-asset-tree.md)                             | The asset tree: a walk of the library, observation order, placement as a pure plan    | Accepted |
| [0028](0028-secrets-on-the-dashboard.md)               | Projects, keys and the owner's sign-in on the dashboard, in an encrypted store        | Accepted |
| [0029](0029-discover-and-read-tools.md)                | The Discover and Read tools, the guides, and hiding the low-level tools per profile   | Accepted |
