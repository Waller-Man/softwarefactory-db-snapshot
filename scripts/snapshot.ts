import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, Client, counts, credentialClient, discover, readBackup } from './backup-common.ts';
import { exportGraph } from './export-hugegraph.ts';
import { restore } from './restore-hugegraph.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultFile = join(root, 'data/current/graph-backup.json');
const modes = ['info', 'check', 'import', 'verify', 'export'];

async function stdinClient(base: string, readonlyOnly: boolean) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    assert(Buffer.byteLength(input) <= 16384, 'Credential input is too long.');
  }
  let value: any;
  try { value = JSON.parse(input.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Invalid credential input. Use the PowerShell entry script.'); }
  input = '';
  assert(typeof value.username === 'string' && value.username.length > 0 &&
    typeof value.password === 'string' && value.password.length > 0, 'Username and password are required.');
  const api = new Client(base, value.username, value.password, readonlyOnly);
  value.password = ''; value.username = '';
  return api;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  assert(modes.includes(mode), 'Usage: node scripts/snapshot.ts info|check|import|verify|export [--url URL] [--graph NAME] [--file FILE] [--apply]');
  const values = new Map<string, string>(), switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    assert(!values.has(key) && !switches.has(key), `Duplicate argument: ${key}`);
    if (['--apply', '--credentials-stdin'].includes(key)) switches.add(key);
    else {
      assert(['--url', '--graph', '--file', '--out'].includes(key), `Unknown option: ${key}`);
      const value = args[++i];
      assert(value && !value.startsWith('--'), `Missing value: ${key}`);
      values.set(key, value);
    }
  }
  assert(!switches.has('--apply') || mode === 'import', '--apply is only valid for import.');
  assert(mode !== 'import' || switches.has('--apply'), 'Writing requires import --apply. Use check first.');
  assert(!values.has('--out') || mode === 'export', '--out is only valid for export.');
  assert(!values.has('--file') || mode !== 'export', '--file is not valid for export.');

  const file = resolve(values.get('--file') ?? defaultFile);
  const backup = mode === 'export' ? undefined : await readBackup(file);
  if (mode === 'info') {
    console.log(JSON.stringify({ file, checksumVerified: true, source: backup!.document.source,
      completedAt: backup!.document.completedAt, counts: counts(backup!.state),
      excludes: backup!.document.excludes }, null, 2));
    return;
  }
  // Require an explicit destination: importing must never silently choose the source database.
  const base = values.get('--url');
  assert(base, '--url is required. Explicitly select the target database.');
  const readonlyOnly = mode !== 'import';
  const api = switches.has('--credentials-stdin') ? await stdinClient(base, readonlyOnly) : credentialClient(base, readonlyOnly);
  let graph: string | undefined;
  try {
    graph = await discover(api, values.get('--graph') ?? 'hugegraph');
    let result: any;
    if (mode === 'export') {
      const out = resolve(values.get('--out') ?? join(root, 'data', 'export-' + new Date().toISOString().replace(/[:.]/g, '-')));
      await mkdir(dirname(out), { recursive: true });
      result = await exportGraph(api, graph, out, api.base);
    } else {
      const graphMode = await api.request('GET', graph + '/mode');
      assert(graphMode.mode === 'NONE', 'Target graph must be in NONE mode. No mode will be changed.');
      result = await restore(api, graph, backup!.state, mode !== 'import');
      if (mode === 'verify') {
        assert(Object.values(result.planned).every(n => n === 0), 'Verification failed: objects are still missing. Run check to see the plan.');
        result = { ...result, mode: 'verify', success: true, allObjectsMatch: true };
      }
    }
    const report = { completedAt: new Date().toISOString(), command: mode, endpoint: api.base, graph,
      ...(mode === 'export' ? {} : { file }), ...result };
    const reports = join(root, 'reports');
    await mkdir(reports, { recursive: true });
    const reportFile = join(reports, `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}.json`);
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ ...report, reportFile }, null, 2));
  } finally { api.clear(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (e) { console.error(e instanceof Error ? e.message : 'Snapshot command failed.'); process.exitCode = 1; }
}
