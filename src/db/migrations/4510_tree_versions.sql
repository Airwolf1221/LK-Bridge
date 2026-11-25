-- v3 F6a.1 (ADR 0076 amendment 1): a version per project's repository tree, bumped by every insert, update and delete
-- of a tree node (triggers, so no write path can miss it). The Reference Types report is cached on it: a reload while
-- nothing in the tree changed reuses the report instead of rebuilding it from every node.
CREATE TABLE tree_versions (
  project_id TEXT PRIMARY KEY,
  version    INTEGER NOT NULL
);

CREATE TRIGGER tree_nodes_version_insert AFTER INSERT ON tree_nodes BEGIN
  INSERT INTO tree_versions (project_id, version) VALUES (NEW.project_id, 1)
    ON CONFLICT (project_id) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER tree_nodes_version_update AFTER UPDATE ON tree_nodes BEGIN
  INSERT INTO tree_versions (project_id, version) VALUES (NEW.project_id, 1)
    ON CONFLICT (project_id) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER tree_nodes_version_delete AFTER DELETE ON tree_nodes BEGIN
  INSERT INTO tree_versions (project_id, version) VALUES (OLD.project_id, 1)
    ON CONFLICT (project_id) DO UPDATE SET version = version + 1;
END;
