-- v2 B2 (ADR 0029): whether a profile's connections are shown the low-level tools (lk_api_list_operations,
-- lk_api_describe_operation, lk_api_paginate_all and every lk_op_*) in tools/list. Hiding is cosmetic: a hidden tool
-- that is called anyway is refused or allowed by the policy gate exactly as before. Default off.
ALTER TABLE agent_profiles ADD COLUMN show_low_level_tools INTEGER NOT NULL DEFAULT 0 CHECK (show_low_level_tools IN (0, 1));
