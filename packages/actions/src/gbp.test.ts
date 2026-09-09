import { describe, it, expect } from 'vitest';
import type { Finding } from '@engine/core';
import { parseGbpOperation } from '@engine/deploy';
import { generateGbpAction } from './gbp.js';
import { generateActions } from './generate.js';
import type { ActionContext } from './context.js';
import type { BuildEnv } from './build.js';

const env: BuildEnv = { now: () => '2026-07-22T00:00:00.000Z', makeId: () => 'act_test' };

function ctx(over: Partial<ActionContext> = {}): ActionContext {
  return { url: 'https://acme.example', target: { kind: 'gbp-api', locationId: 'loc1' }, ...over };
}

function finding(issueType: string, evidence: object = {}): Finding {
  return {
    id: 'fnd1',
    entityId: 'e1',
    source: 'local',
    issueType,
    severity: 0.5,
    predictedImpact: 0.5,
    evidence,
    actionTemplates: [{ type: 'gbp', label: 'x', description: 'y' }],
    createdAt: '2026-07-22T00:00:00.000Z',
  };
}

describe('generateGbpAction', () => {
  it('builds an update-field op from the finding field + ctx value', () => {
    const a = generateGbpAction(finding('incomplete-gbp-field', { field: 'description' }), ctx({ gbp: { fieldValue: 'A neighbourhood shop.' } }), env)!;
    expect(a.type).toBe('gbp');
    expect(parseGbpOperation(a)).toEqual({ kind: 'update-field', field: 'description', value: 'A neighbourhood shop.' });
  });

  it('builds a reply-review op', () => {
    const a = generateGbpAction(finding('unanswered-reviews'), ctx({ gbp: { reviewName: 'accounts/1/locations/2/reviews/3', reviewReply: 'Thank you!' } }), env)!;
    expect(parseGbpOperation(a)).toEqual({ kind: 'reply-review', reviewName: 'accounts/1/locations/2/reviews/3', comment: 'Thank you!' });
  });

  it('builds a create-post op', () => {
    const a = generateGbpAction(finding('low-review-velocity'), ctx({ gbp: { postSummary: 'Open this weekend!' } }), env)!;
    expect(parseGbpOperation(a)).toEqual({ kind: 'create-post', summary: 'Open this weekend!' });
  });

  it('returns null when the target is not a GBP location', () => {
    const a = generateGbpAction(finding('incomplete-gbp-field', { field: 'description' }), ctx({ target: { kind: 'edge-worker', workerName: 'w' }, gbp: { fieldValue: 'x' } }), env);
    expect(a).toBeNull();
  });

  it('returns null when the caller supplied no value (nothing invented)', () => {
    expect(generateGbpAction(finding('incomplete-gbp-field', { field: 'description' }), ctx({ gbp: {} }), env)).toBeNull();
    expect(generateGbpAction(finding('unanswered-reviews'), ctx({}), env)).toBeNull();
  });

  it('returns null for a non-whitelisted field', () => {
    expect(generateGbpAction(finding('incomplete-gbp-field', { field: 'photos' }), ctx({ gbp: { fieldValue: 'x' } }), env)).toBeNull();
  });
});

describe('generateActions dispatch (gbp template)', () => {
  it('emits a gbp action for a B5 local finding with a gbp template', () => {
    const { actions } = generateActions(finding('incomplete-gbp-field', { field: 'title' }), ctx({ gbp: { fieldValue: 'Acme Store' } }), env);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('gbp');
    expect(parseGbpOperation(actions[0])).toEqual({ kind: 'update-field', field: 'title', value: 'Acme Store' });
  });

  it('emits nothing (no throw) when the gbp value is missing', () => {
    expect(generateActions(finding('unanswered-reviews'), ctx({}), env).actions).toHaveLength(0);
  });
});
