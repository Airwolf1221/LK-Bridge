/** Public surface of `src/projects` (v2 A1, docs/projects.md): the project registry and its store. */
export {
  ProjectRegistry,
  createProjectRegistry,
  type CreateProjectRegistryOptions,
  type ProjectsRuntime,
  type RegistryLogger,
} from './registry.js';
export { ProjectStore } from './store.js';
export {
  ProjectSelector,
  type ProjectSelection,
  type ProjectSelectionError,
  type SelectableProjects,
  type SelectedProject,
} from './selection.js';
export { StaticProjects, type StaticProject } from './static.js';
export { InstanceGuard, InstanceLockError, type InstanceGuardOptions } from './instance.js';
export {
  PROJECT_SETTING_KEYS,
  SettingValueError,
  parseSettingValue,
  parseProjectSettings,
  projectSetting,
  projectSettingsSchema,
  type ProjectSettings,
  type SettingKind,
} from './settings.js';
export {
  ALL_PROJECTS,
  isAllProjects,
  type AllProjects,
  type ProjectRecord,
  type ProjectScope,
  type ProjectStatus,
  type ProjectView,
} from './types.js';
