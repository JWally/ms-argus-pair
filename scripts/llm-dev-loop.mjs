#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const [, , command, ...args] = process.argv;

function run(cmd, cmdArgs, options = {}) {
  console.log(`\n$ ${[cmd, ...cmdArgs].join(' ')}`);
  const result = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...options.env },
  });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

function print(text) {
  console.log(text.trimStart());
}

function requireArg(name, value) {
  if (!value) {
    console.error(`Missing ${name}.`);
    process.exit(2);
  }
}

function usage() {
  print(`
LLM dev-loop helper

Usage:
  npm run llm:loop -- start
  npm run llm:loop -- baseline
  npm run llm:loop -- branch <branch-name>
  npm run llm:loop -- verify
  npm run llm:loop -- deploy
  npm run llm:loop -- red-team
  npm run llm:loop -- merge-dev-loop

See LLM_DEV_LOOP.md for the full workflow and merge rules.
`);
}

switch (command) {
  case 'start': {
    run('git', ['switch', 'main']);
    run('git', ['pull', '--ff-only']);
    run('git', ['switch', '-C', 'dev-loop']);
    print(`
Created or reset local dev-loop from main.

Next:
  git push -u origin dev-loop
  npm run llm:loop -- baseline
`);
    break;
  }
  case 'baseline': {
    run('npm', ['run', 'test:coverage']);
    run('npm', ['run', 'hygiene:stats']);
    run('npm', ['run', 'quality']);
    break;
  }
  case 'branch': {
    const branchName = args[0];
    requireArg('branch-name', branchName);
    run('git', ['switch', 'dev-loop']);
    run('git', ['pull', '--ff-only']);
    run('git', ['switch', '-c', branchName]);
    break;
  }
  case 'verify': {
    run('npm', ['run', 'typecheck']);
    run('npm', ['run', 'lint']);
    run('npm', ['test']);
    run('npm', ['run', 'test:hygiene']);
    run('npm', ['run', 'build'], { env: { PAIR_ALLOW_ORIGIN_FALLBACK: '1' } });
    break;
  }
  case 'deploy': {
    run('npm', ['run', 'deploy']);
    run('npm', ['run', 'test:e2e'], {
      env: { PAIR_HOST: 'https://captcha-dev-jw.argus.pw' },
    });
    break;
  }
  case 'red-team':
  case 'red' + 'team': {
    print(`
Red-team checkpoint

Read _DELETE_DELETE_DELETE_ATTACKING.md, then run the bots that match the branch.

Required classification:
  blocked
  stolen_but_failed
  friction_loss
  server_gate_bypass
  test_stale

Do not merge server_gate_bypass without a failing regression test and fix.

Common external harness commands live in ms-argus-attack-bots. Use the target:
  PAIR_HOST=https://captcha-dev-jw.argus.pw
`);
    break;
  }
  case 'merge-dev-loop': {
    run('git', ['status', '--short', '--branch']);
    print(`
Before merging, confirm:
  - npm run llm:loop -- verify passed
  - npm run llm:loop -- deploy passed or was correctly skipped
  - red-team checks were run or explicitly scoped out
  - the branch has been committed

Then run:
  git switch dev-loop
  git pull --ff-only
  git merge --ff-only <your-branch>
  git push origin dev-loop
`);
    break;
  }
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    usage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(2);
}
