#!/usr/bin/env node
// Prints the canonical pair host so the deploy script can bake it into
// the Vite build via VITE_PAIR_URL_BASE. Same source of truth as the
// CDK stack (pair-config.mjs).
import { config } from './pair-config.mjs';
process.stdout.write(config.canonicalHost);
