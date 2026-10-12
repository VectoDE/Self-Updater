import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['dist/', 'coverage/', 'site/dist/', 'node_modules/'] },
  js.configs.recommended,
  // The rules SonarQube applies ("Sonar way"), so issues show up before the code reaches a scanner.
  sonarjs.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Non-null assertions mark lookups the code has just guaranteed (map entries built from the same list).
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
  },
  { files: ['site/src/**/*.ts'], languageOptions: { globals: { ...globals.browser } } },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Tests call methods through expect(...).toThrow and build throwaway values on purpose.
      '@typescript-eslint/unbound-method': 'off',
      'sonarjs/no-hardcoded-passwords': 'off',
      'sonarjs/pseudo-random': 'off',
      // Asymmetric matchers such as expect.stringContaining() are typed as any.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // The integration tests run git and ssh-keygen from PATH, like the updater does on a server.
      'sonarjs/no-os-command-from-path': 'off',
      // Fixtures: ftp:// URLs prove they are rejected, and 1.2.3.4 is a version number, not an address.
      'sonarjs/no-clear-text-protocols': 'off',
      'sonarjs/no-hardcoded-ip': 'off',
    },
  },
  {
    // Command-line scripts print their results.
    files: ['scripts/**'],
    rules: { 'no-console': 'off' },
  },
]);
