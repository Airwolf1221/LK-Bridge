# ADR 0005: Low-level API behind meta-tools

Status: Accepted (chunk 0). Implements PLAN §7.

## Decision

The 89 LK operations are reached through a small set of meta-tools (`lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_call`, `lk_api_batch`, `lk_api_paginate_all`, `lk_upload_image`) plus the `bridge_*` awareness tools. Per-operation tools (`lk_op_<operationId>`) exist only behind `MCP_EXPOSE_PER_OP_TOOLS=true`, default off. Intention-level tools get the un-prefixed top-level namespace later and are built on the job engine and registry, never on raw HTTP.

## Consequences

- The claude.ai tool list stays small and the main slots stay free.
- Tool descriptions state rate cost and risk, taken from registry metadata.
