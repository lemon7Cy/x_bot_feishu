import js from '@eslint/js';

export default [
  {
    ignores: ['node_modules/**', 'data/**', 'coverage/**', '.npm-cache/**', '.venv/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        AbortController: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        globalThis: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        structuredClone: 'readonly',
        document: 'readonly',
        window: 'readonly',
        EventSource: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        Blob: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-escape': 'off',
      'preserve-caught-error': 'off'
    }
  }
];
