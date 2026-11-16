-- v3 F2 (ADR 0049 decision 1): whether the bridge named a linked event with a tail (`<opening words> – <Date cell>`,
-- ADR 0048 decision 3), and which tail it wrote. Only a tail the bridge wrote is ever rewritten when the row's Date cell
-- changes: '' = the bridge wrote no tail; any other text = the tail it wrote; NULL = a link made before this column,
-- recognised once from its chronology record (the event's name equalled `opening words – Date cell` at the time).
ALTER TABLE chronology_links ADD COLUMN name_tail TEXT;
