import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import importX from 'eslint-plugin-import-x';
import security from 'eslint-plugin-security';
import unicorn from 'eslint-plugin-unicorn';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: [
      'dist',
      'cdk.out',
      'node_modules',
      '**/*.d.ts',
      'loader',
      'wasm/*/pkg', // generated wasm-bindgen glue
      'wasm/*/target',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        crypto: 'readonly',
        process: 'readonly',
        AbortController: 'readonly',
        Buffer: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLDivElement: 'readonly',
        ResizeObserver: 'readonly',
        Worker: 'readonly',
        self: 'readonly',
        CryptoKey: 'readonly',
        // Lib DOM types for WebRTC + Fetch in our pairing client.
        RTCPeerConnection: 'readonly',
        RTCSessionDescription: 'readonly',
        RTCIceCandidate: 'readonly',
        RTCDataChannel: 'readonly',
        RTCIceServer: 'readonly',
        RTCIceCandidateInit: 'readonly',
        RTCIceCandidatePairStats: 'readonly',
        RTCSessionDescriptionInit: 'readonly',
        RequestInit: 'readonly',
        WebSocket: 'readonly',
        Event: 'readonly',
        ErrorEvent: 'readonly',
        MessageEvent: 'readonly',
        ServiceWorker: 'readonly',
        AbortSignal: 'readonly',
        queueMicrotask: 'readonly',
        indexedDB: 'readonly',
        IDBDatabase: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooks,
      'import-x': importX,
      security,
      unicorn,
      sonarjs,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...security.configs.recommended.rules,
      // Ratchet: the ceiling is the current worst offender (see comment where
      // it's set) — lower it as functions get decomposed, never raise it.
      'sonarjs/cognitive-complexity': ['error', 15],
      complexity: ['error', { max: 20 }],
      'max-depth': ['error', 4],
      'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': [
        'error',
        { max: 120, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      'max-params': ['error', 6],
      'max-statements': ['error', 60],
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowAny: false, allowBoolean: true, allowNullish: true, allowNumber: true },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'variable',
          modifiers: ['const', 'global'],
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allowDouble',
        },
        {
          selector: ['variable', 'function'],
          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
          leadingUnderscore: 'allowDouble',
        },
      ],
      'unicorn/consistent-function-scoping': 'error',
      'unicorn/no-array-for-each': 'off',
      'unicorn/no-null': 'off',
      'unicorn/prefer-module': 'off',
      'unicorn/prevent-abbreviations': 'off',
      'import-x/order': [
        'error',
        {
          'newlines-between': 'never',
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        },
      ],
    },
  },
  {
    // Known legacy consolidation points. Keep these exemptions narrow so new
    // code gets the ratchet pressure while we split the handlers intentionally.
    files: ['cdk/lib/pair-api.ts', 'src/lib/pair.ts', 'src/phone-main.tsx'],
    rules: {
      complexity: 'off',
      'max-depth': 'off',
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'max-params': 'off',
      'max-statements': 'off',
      'sonarjs/cognitive-complexity': 'off',
    },
  },
  {
    // Existing browser handlers intentionally fire async flows from effects and
    // event props. New modules still get strict promise handling.
    files: [
      'cdk/lib/pair-api.ts',
      'cdk/lib/ws-handler.ts',
      'src/lib/pair.ts',
      'src/lib/pair-qr-worker.ts',
      'src/pages/Embed.tsx',
      'src/pages/MerchantSso.tsx',
      'src/pages/MerchantValidate.tsx',
      'src/pages/Pair.tsx',
      'src/pages/SsoChallenge.tsx',
      'src/phone-main.tsx',
    ],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      'unicorn/consistent-function-scoping': 'off',
    },
  },
  {
    files: [
      'cdk/bin/app.ts',
      'cdk/lib/captcha-cdn/static-site.ts',
      'cdk/lib/pair-stack.ts',
      'src/pages/Embed.tsx',
      'src/pages/MerchantValidate.tsx',
      'src/pages/Pair.tsx',
    ],
    rules: {
      complexity: 'off',
      'max-depth': 'off',
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'max-params': 'off',
      'max-statements': 'off',
      'sonarjs/cognitive-complexity': 'off',
    },
  },
  {
    files: ['tests/**/*.test.ts'],
    plugins: {
      vitest,
    },
    rules: {
      ...vitest.configs.recommended.rules,
      'max-lines-per-function': 'off',
      'max-statements': 'off',
      'vitest/no-conditional-expect': 'off',
    },
  },
  {
    files: ['**/*.mjs', 'scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  prettier,
];
