/**
 * Fills the database with realistic demo data: groups, context files, demo-* servers, guard layers,
 * keys, rules, Studio scenarios and about 420 logged sessions from the last 14 days.
 * Safe to run again. Target another database with GUARDRAIL_DB=… npm run seed:demo.
 * Demo servers point at the mock vLLM server: npm run mock:vllm (or set DEMO_MOCK_URL).
 */
import { seedDemo } from '../src/lib/demo-seed';

const r = seedDemo({ mockUrl: process.env.DEMO_MOCK_URL });
console.log('Demo data ready:', r);
