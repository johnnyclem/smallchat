/**
 * Seven starter context-shift fixtures.
 *
 * Six are non-baseline: writeContext and readContext disagree along the
 * shiftType axis, and the expected answer needs what the read context
 * changes about the payload.
 *
 * Every fixture uses the same neutral template. A template is written with
 * the engram, before the read context exists, so it cannot know the answer;
 * the 0.x templates spelled the expected answer out, and an interpreter that
 * ignored payload and context passed the gate on them (SH-18). The answer
 * terms now appear only in `task.expectedAnswer`, so only an interpreter
 * that reasons from the payload and the read context can surface them. The
 * regex tier cannot, and ties the raw arm.
 *
 * One (baseline-raw-wins-01) is a calibration fixture: payload is a precise
 * verbatim string and the question requires that exact string. Excluded
 * from win-rate aggregation; the interpreted arm must tie the raw arm.
 *
 * Seven fixtures are a starter set, far below the gate's minimum of 30
 * decided fixtures: bring your own held-out set to measure the claim.
 */
import type { BenchmarkFixture } from './types.js';

/** The engram template every starter fixture uses (the store's default wording). */
export const STARTER_TEMPLATE = 'Earlier note, still relevant: {{payload}}';

export const STARTER_FIXTURES: BenchmarkFixture[] = [
  {
    id: 'tech-stack-shift-01',
    shiftType: 'tech-stack',
    payload: 'user prefers CLI tools',
    interpreterTemplate: STARTER_TEMPLATE,
    writeContext: 'a command-line utility',
    readContext: 'a web dashboard for non-technical operators',
    task: {
      question:
        'When recommending interaction patterns for the dashboard, should we lean on power-user keyboard flows?',
      expectedAnswer:
        'yes prefer keyboard-driven flows because the user prefers CLI tools',
    },
  },
  {
    id: 'audience-shift-01',
    shiftType: 'audience',
    payload: 'explain the design like the audience is junior engineers',
    interpreterTemplate: STARTER_TEMPLATE,
    writeContext: 'an internal RFC for senior staff',
    readContext: 'a blog post for executives without engineering background',
    task: {
      question: 'Should the blog post use heavy engineering jargon and acronyms?',
      expectedAnswer:
        'no use plain language define jargon lead with concrete example for executives',
    },
  },
  {
    id: 'tone-shift-01',
    shiftType: 'tone',
    payload: 'always sign off with a warm note',
    interpreterTemplate: STARTER_TEMPLATE,
    writeContext: 'a customer support reply',
    readContext: 'an incident postmortem read by partner teams',
    task: {
      question:
        'How should the postmortem close out at the end of the document?',
      expectedAnswer:
        'close with a warm note appreciation gratitude or forward-looking sentence',
    },
  },
  {
    id: 'time-frame-shift-01',
    shiftType: 'time-frame',
    payload: 'the Q3 deadline is August 15',
    interpreterTemplate: STARTER_TEMPLATE,
    writeContext: 'July sprint planning',
    readContext: 'mid-September Q3 retrospective and Q4 planning',
    task: {
      question:
        'When discussing the August 15 deadline now, is it a future commitment or a past event?',
      expectedAnswer:
        'past event already passed retrospective fact not future commitment',
    },
  },
  {
    id: 'scope-expansion-01',
    shiftType: 'scope-expansion',
    payload: 'auth uses JWT signed with HS256',
    interpreterTemplate: STARTER_TEMPLATE,
    writeContext: 'a single-service prototype',
    readContext: 'a multi-tenant federated platform',
    task: {
      question:
        'For multi-tenant federation, is the existing HS256 JWT setup sufficient, or does it need revisiting?',
      expectedAnswer:
        'needs revisiting HS256 shared secret does not scale across tenants',
    },
  },
  {
    id: 'terminology-shift-01',
    shiftType: 'terminology',
    payload: 'the customer needs reporting',
    interpreterTemplate: STARTER_TEMPLATE,
    writeContext: 'a B2C product spec',
    readContext: 'an enterprise sales deck where "customer" means a tenant org',
    task: {
      question:
        'In the enterprise deck, what does "customer needs reporting" actually mean — what kind of customer and what kind of reporting?',
      expectedAnswer:
        'tenant organization scoped analytics not individual end-user',
    },
  },
  {
    id: 'baseline-raw-wins-01',
    shiftType: 'baseline',
    expectRawWins: true,
    payload: 'the deploy key fingerprint is SHA256:9f2b3c5d7e1a',
    interpreterTemplate: STARTER_TEMPLATE,
    writeContext: 'rotating deploy keys',
    readContext: 'verifying CI access during an outage',
    task: {
      question: 'What is the deploy key fingerprint?',
      expectedAnswer: 'SHA256:9f2b3c5d7e1a',
    },
  },
];
