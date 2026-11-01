import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/generated/**', 'docs/**', '**/*.config.*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // NFR-MNT-001 module boundaries: other API modules are imported only through their index.ts.
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: '^\\.\\./(?!\\.\\.)[^/]+/(?!index(\\.js)?$).+', message: 'Import other modules through their index.ts only.' }] }],
      // ADR-004 / Arch 8.1: tenant lookups must filter by clinic_id; findUnique({ where: { id } }) is forbidden.
      'no-restricted-syntax': ['error', { selector: "CallExpression[callee.property.name='findUnique']", message: 'Use findFirst({ where: { id, clinicId } }) on tenant models.' }],
    },
  },
);
