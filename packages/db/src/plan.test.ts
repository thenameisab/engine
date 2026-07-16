import { describe, expect, it } from 'vitest';
import { checksum, parseMigrationFilename, planMigrations } from './plan.js';
import type { AppliedMigration, MigrationFile } from './plan.js';

function file(version: string, name: string, sql = `-- ${version}`): MigrationFile {
  return { version, name, filename: `${version}_${name}.sql`, sql };
}

function appliedFrom(f: MigrationFile): AppliedMigration {
  return { version: f.version, name: f.name, checksum: checksum(f.sql) };
}

describe('parseMigrationFilename', () => {
  it('splits version and name', () => {
    expect(parseMigrationFilename('0002_onboarding_billing.sql')).toEqual({
      version: '0002',
      name: 'onboarding_billing',
    });
  });

  it.each([
    '1_init.sql',
    '0001-init.sql',
    '0001_Init.sql',
    'init.sql',
    '0001_init.txt',
    '00001_init.sql',
  ])('rejects %s', (filename) => {
    expect(() => parseMigrationFilename(filename)).toThrow(/must look like/);
  });
});

describe('checksum', () => {
  it('is stable and content-sensitive', () => {
    expect(checksum('select 1')).toBe(checksum('select 1'));
    expect(checksum('select 1')).not.toBe(checksum('select 2'));
  });
});

describe('planMigrations', () => {
  const init = file('0001', 'init');
  const billing = file('0002', 'onboarding_billing');

  it('treats every file as pending on a virgin database', () => {
    const plan = planMigrations([billing, init], []);
    expect(plan.pending.map((f) => f.version)).toEqual(['0001', '0002']);
  });

  it('returns nothing pending when all are applied', () => {
    const plan = planMigrations([init, billing], [appliedFrom(init), appliedFrom(billing)]);
    expect(plan.pending).toEqual([]);
  });

  it('returns only the un-applied tail', () => {
    const plan = planMigrations([init, billing], [appliedFrom(init)]);
    expect(plan.pending.map((f) => f.filename)).toEqual(['0002_onboarding_billing.sql']);
  });

  it('rejects an applied migration whose body changed', () => {
    const edited = file('0001', 'init', 'select 999');
    expect(() => planMigrations([edited, billing], [appliedFrom(init)])).toThrow(/drift/i);
  });

  it('rejects a new migration that sorts below an applied one', () => {
    const backfill = file('0001', 'sneaky_backfill');
    expect(() => planMigrations([backfill, billing], [appliedFrom(billing)])).toThrow(
      /out-of-order/i,
    );
  });

  it('rejects a database that is ahead of the checkout', () => {
    expect(() => planMigrations([init], [appliedFrom(init), appliedFrom(billing)])).toThrow(
      /no matching file/i,
    );
  });

  it('rejects duplicate versions', () => {
    expect(() => planMigrations([init, file('0001', 'other')], [])).toThrow(/duplicate/i);
  });
});
