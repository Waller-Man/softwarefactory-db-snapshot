import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, canonical, counts, credentialClient, discover, hash, readBackup, snapshot } from './backup-common.ts';

export async function exportGraph(api: Parameters<typeof snapshot>[0], graph: string, directory: string, base: string) {
  const startedAt = new Date().toISOString();
  const first = await snapshot(api, graph);
  const second = await snapshot(api, graph);
  assert(canonical(first) === canonical(second), 'Graph changed between full reads; retry export while writes are paused. No valid backup was produced.');
  const dataSha256 = hash(canonical(first));
  const summary = counts(first);
  const document = { format: 'softwarefactory-hugegraph-rest-v1', source: { endpoint: base, graph, serverVersionDeclared: '1.7.0' },
    startedAt, completedAt: new Date().toISOString(), dataSha256,
    consistency: 'Two consecutive complete paginated reads matched; not an atomic transaction snapshot.',
    includes: ['propertykeys', 'vertexlabels', 'edgelabels', 'indexlabels', 'vertices', 'edges'],
    excludes: ['authentication/users/roles/passwords', 'Docker/server configuration', 'graph variables', 'external code and artifact files', 'task history'],
    counts: summary, data: first };
  // Fail if the output directory already exists: never overwrite another backup.
  await mkdir(directory);
  const file = join(directory, 'graph-backup.json');
  const bytes = JSON.stringify(document, null, 2) + '\n';
  await writeFile(file, bytes, { encoding: 'utf8', flag: 'wx' });
  await writeFile(file + '.sha256', hash(bytes) + '  graph-backup.json\n', { encoding: 'utf8', flag: 'wx' });
  await readBackup(file);
  const verification = { success: true, completedAt: new Date().toISOString(), source: document.source, counts: summary,
    dataSha256, fileSha256: hash(bytes), bytes: Buffer.byteLength(bytes),
    checks: { exportUsedGetOnly: true, consecutiveCompleteReadsMatched: true, uniqueVertexAndEdgeIds: true,
      allEdgeEndpointsPresent: true, allEndpointLabelsMatchSchema: true, backupReadbackAndChecksum: true },
    restoreTesting: 'Not restored to a live database; importer is tested with a simulated API.' };
  await writeFile(join(directory, 'verification.json'), JSON.stringify(verification, null, 2) + '\n', 'utf8');
  return { directory, ...verification };
}
async function main() {
  const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
  const base = arg('--url', 'http://127.0.0.1:18080'), name = arg('--graph', 'hugegraph');
  const directory = resolve(arg('--out', 'backups/softwarefactory-' + new Date().toISOString().replace(/[:.]/g, '-')));
  const client = credentialClient(base);
  try {
    const graph = await discover(client, name);
    console.log('Read-only export: ' + graph);
    const result = await exportGraph(client, graph, directory, client.base);
    console.log(JSON.stringify(result, null, 2));
  } finally { client.clear(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (e) { console.error(e instanceof Error ? e.message : 'Export failed'); process.exitCode = 1; }
}
