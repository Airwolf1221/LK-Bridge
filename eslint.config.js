import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const upstreamHost = '/legendkeeper\\.com/i';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'ui/dist/**', '**/*.generated.ts', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // CLAUDE.md: LegendKeeper is reached only through src/lk/governor. No raw fetch, no upstream host
    // literals outside src/lk.
    files: ['src/**/*.ts'],
    ignores: ['src/lk/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Reach LegendKeeper only through src/lk/governor.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=${upstreamHost}]`,
          message: 'Do not hard-code the LegendKeeper host outside src/lk.',
        },
        {
          selector: `TemplateElement[value.raw=${upstreamHost}]`,
          message: 'Do not hard-code the LegendKeeper host outside src/lk.',
        },
      ],
    },
  },
  {
    files: ['src/lk/**/*.ts'],
    ignores: ['src/lk/governor/**'],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Only src/lk/governor may call fetch.' }],
    },
  },
);
