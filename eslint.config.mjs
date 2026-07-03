import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import importX from 'eslint-plugin-import-x';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['dist', 'cdk.out', 'node_modules', '**/*.d.ts', 'scripts/jsQR.js', 'loader'] },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
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
      sonarjs,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // Ratchet: the ceiling is the current worst offender (see comment where
      // it's set) — lower it as functions get decomposed, never raise it.
      'sonarjs/cognitive-complexity': ['error', 15],
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
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
