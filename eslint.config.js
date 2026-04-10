import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Core project rule: no any
      '@typescript-eslint/no-explicit-any': 'error',

      // Prefer type imports
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],

      // Allow underscore-prefixed unused vars (common pattern for destructuring)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Allow non-null assertions (common after Map.has() checks, array bounds)
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Allow template literals with numbers and booleans
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      // MCP tool handlers and CLI commands are async for interface conformance
      '@typescript-eslint/require-await': 'off',

      // Allow void expressions in arrow shorthand (e.g., logger calls)
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true },
      ],

      // Warn on deprecated API usage (often from external deps)
      '@typescript-eslint/no-deprecated': 'warn',

      // Allow dynamic delete (used in mitm-proxy header manipulation)
      '@typescript-eslint/no-dynamic-delete': 'off',
    },
  },
  {
    // Cookie validation regexes intentionally match control characters
    files: ['src/auth.ts'],
    rules: {
      'no-control-regex': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'test/', 'eslint.config.js'],
  },
);
