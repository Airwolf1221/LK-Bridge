# Architecture decision records

One short record per major decision. To change a decision in `docs/PLAN.md`, add a new ADR that supersedes the old one; do not edit history.

| #                                                  | Title                                                          | Status   |
| -------------------------------------------------- | -------------------------------------------------------------- | -------- |
| [0001](0001-stack.md)                              | Runtime and stack                                              | Accepted |
| [0002](0002-generated-operation-registry.md)       | Generated operation registry and vendored spec                 | Accepted |
| [0003](0003-lk-access-through-governor.md)         | All LegendKeeper traffic goes through the governor             | Accepted |
| [0004](0004-mcp-sdk-v2.md)                         | MCP SDK: v2 split packages                                     | Accepted |
| [0005](0005-meta-tool-mcp-surface.md)              | Low-level API behind meta-tools                                | Accepted |
| [0006](0006-mcp-sdk-v2-confirmed-for-transport.md) | MCP SDK v2 confirmed for the transport, with our own auth gate | Accepted |
| [0007](0007-oauth-authorization-server-design.md)  | OAuth authorization server design choices                      | Accepted |
| [0008](0008-chatgpt-as-a-client.md)                | ChatGPT as a supported client                                  | Accepted |
| [0009](0009-refresh-token-grace-window.md)         | Refresh-token grace window                                     | Accepted |
| [0010](0010-job-engine-verification-and-holds.md)  | Job engine verification, `uncertain` steps and write holds     | Accepted |
| [0011](0011-live-policy-evaluation.md)             | Policy attaches to profiles and is evaluated live              | Accepted |
