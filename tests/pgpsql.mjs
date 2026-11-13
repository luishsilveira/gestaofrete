// Adaptador de teste: executa consultas no PostgreSQL local via psql (sem driver npm).
import { spawnSync } from 'node:child_process';
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (Array.isArray(v)) return `'{${v.join(',')}}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
export function psql(sql) {
  const r = spawnSync('su', ['postgres', '-c', 'psql -h /tmp/pgt -p 5499 -d gf -v ON_ERROR_STOP=1 -At -q'], { input: sql, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('SQL: ' + r.stderr + '\n' + sql.slice(0, 400));
  return r.stdout;
}
export const db = {
  log: [],
  async query(sql, params = []) {
    let s = sql;
    for (let i = params.length; i >= 1; i--) s = s.split('$' + i).join(lit(params[i - 1]));
    const tr = s.trim();
    this.log.push(tr.split(/\s+/).slice(0, 4).join(' '));
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(tr)) return { rows: [] };
    let q;
    if (/^(SELECT|WITH)/i.test(tr)) q = `SELECT coalesce(json_agg(t),'[]') FROM (${tr}) t;`;
    else if (/RETURNING/i.test(tr)) q = `WITH t AS (${tr}) SELECT coalesce(json_agg(t),'[]') FROM t;`;
    else { psql(tr + ';'); return { rows: [] }; }
    return { rows: JSON.parse(psql(q).trim() || '[]') };
  },
};
