/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Cycles make ownership and extraction harder; keep new modules acyclic.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-src-to-cdk',
      severity: 'error',
      comment: 'Browser/UI code must not import Lambda/CDK implementation details.',
      from: { path: '^src/' },
      to: { path: '^cdk/' },
    },
    {
      name: 'no-cdk-to-src-pages',
      severity: 'error',
      comment: 'Server/CDK code may share pure libs, but must not depend on React pages.',
      from: { path: '^cdk/' },
      to: { path: '^src/pages/' },
    },
    {
      name: 'no-tests-in-production',
      severity: 'error',
      comment: 'Production code must not import tests or test helpers.',
      from: { pathNot: '^(tests/|scripts/)' },
      to: { path: '^tests/' },
    },
  ],
  options: {
    doNotFollow: {
      path: '^(node_modules|dist|cdk\\.out|loader)',
    },
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
    },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    preserveSymlinks: false,
  },
};
