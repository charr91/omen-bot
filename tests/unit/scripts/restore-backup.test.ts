import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const script = path.join(repoRoot, 'scripts/restore-backup.sh');

function bash(inline: string): string {
  return execFileSync('bash', ['-c', inline], {
    encoding: 'utf8',
    cwd: repoRoot,
  }).trim();
}

const prelude = `RESTORE_BACKUP_SOURCE_ONLY=1 source ${JSON.stringify(script)}`;

describe('restore-backup.sh helpers', () => {
  it('maps dump filenames to the schema that should hold restored objects', () => {
    expect(bash(`${prelude} && expected_schema_for_dump omen.dump`)).toBe('public');
    expect(bash(`${prelude} && expected_schema_for_dump smart_money_feed.dump`)).toBe('feed');
    expect(bash(`${prelude} && expected_schema_for_dump other.dump`)).toBe('');
  });

  it('counts relations in any non-system schema, not only public', () => {
    const sql = bash(`${prelude} && user_relation_count_sql`);
    expect(sql).toMatch(/information_schema/);
    expect(sql).toMatch(/pg_catalog/);
    expect(sql).toMatch(/pg_toast/);
    expect(sql).toMatch(/pg_temp%/);
    expect(sql).not.toMatch(/relnamespace = 'public'/);
  });

  it('can count relations in a named schema such as feed', () => {
    const sql = bash(`${prelude} && schema_relation_count_sql feed`);
    expect(sql).toMatch(/n\.nspname = 'feed'/);
  });
});
