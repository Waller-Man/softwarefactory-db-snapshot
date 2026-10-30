import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exportGraph } from './export-hugegraph.ts';
import { preflight, restore } from './restore-hugegraph.ts';
import { Client, counts, readBackup, snapshot, type Snapshot, type Row } from './backup-common.ts';

function empty(): Snapshot { return { schema: { propertykeys: [], vertexlabels: [], edgelabels: [], indexlabels: [] }, vertices: [], edges: [] }; }
function fixture(): Snapshot {
  return { schema: {
    propertykeys: [{ id: 10, name: 'name', data_type: 'TEXT', cardinality: 'SINGLE', aggregate_type: 'NONE', write_type: 'OLTP', user_data: { '~create_time': 'old' } }],
    vertexlabels: [
      { id: 10, name: 'Agent', id_strategy: 'PRIMARY_KEY', properties: ['name'], nullable_keys: [], primary_keys: ['name'], enable_label_index: true },
      { id: 20, name: 'Capability', id_strategy: 'CUSTOMIZE_STRING', properties: ['name'], nullable_keys: [], primary_keys: [], enable_label_index: true }],
    edgelabels: [{ id: 4, name: 'HAS_AGENT', source_label: 'Capability', target_label: 'Agent', frequency: 'SINGLE', properties: [], nullable_keys: [], sort_keys: [], enable_label_index: false }],
    indexlabels: [{ id: 3, name: 'idx_agent_name', base_type: 'VERTEX_LABEL', base_value: 'Agent', index_type: 'SECONDARY', fields: ['name'] }],
  }, vertices: [ { id: 'old-primary-id', label: 'Agent', properties: { name: 'Agent A' } },
    { id: 'cap:stable', label: 'Capability', properties: { name: '能力分类' } } ],
  edges: [{ id: 'old-edge', label: 'HAS_AGENT', outV: 'cap:stable', inV: 'old-primary-id', outVLabel: 'Capability', inVLabel: 'Agent', properties: {} }] };
}
export class FakeApi {
  state: Snapshot;
  writes: { method: string; path: string; body: any }[] = [];
  constructor(state = empty()) { this.state = structuredClone(state); }
  async request(method: 'GET' | 'POST', path: string, body?: Row): Promise<any> {
    const url = new URL('http://localhost' + path);
    if (method === 'GET') {
      if (url.pathname.endsWith('/schema')) return structuredClone(this.state.schema);
      const resource = url.pathname.endsWith('/vertices') ? 'vertices' : url.pathname.endsWith('/edges') ? 'edges' : undefined;
      if (!resource) throw new Error('Unexpected GET: ' + path);
      const offset = Number(url.searchParams.get('page') || 0), rows = this.state[resource].slice(offset, offset + 1);
      return { [resource]: structuredClone(rows), page: offset + 1 < this.state[resource].length ? String(offset + 1) : null };
    }
    this.writes.push({ method, path, body: structuredClone(body) });
    const kind = path.split('/schema/')[1];
    if (kind) {
      const row = { ...structuredClone(body), id: 900 + this.writes.length, status: 'CREATED', user_data: { ...body?.user_data, '~create_time': 'new' } };
      this.state.schema[kind].push(row); return row;
    }
    if (path.endsWith('/vertices')) {
      const row = { ...structuredClone(body), id: body?.id ?? 'regenerated-primary:' + body?.label + ':' + JSON.stringify(body?.properties) };
      this.state.vertices.push(row); return row;
    }
    if (path.endsWith('/edges')) {
      const ids = new Set(this.state.vertices.map(v => v.id));
      assert.ok(ids.has(body?.outV) && ids.has(body?.inV), 'restore must use mapped native IDs');
      const row = { ...structuredClone(body), id: 'regenerated-edge:' + this.writes.length };
      this.state.edges.push(row); return row;
    }
    throw new Error('Unexpected write: ' + path);
  }
}

test('export reads all pages, preserves content, verifies checksum, and performs no writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hg-export-'));
  try {
    const api = new FakeApi(fixture()), output = join(root, 'backup');
    const result = await exportGraph(api, '/graphspaces/DEFAULT/graphs/hugegraph', output, 'http://127.0.0.1:18080');
    const { state } = await readBackup(join(output, 'graph-backup.json'));
    assert.deepEqual(counts(state), counts(fixture())); assert.equal(result.success, true); assert.equal(api.writes.length, 0);
    const filename = join(output, 'graph-backup.json');
    await writeFile(filename, (await readFile(filename, 'utf8')) + ' ');
    await assert.rejects(readBackup(filename), /checksum/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('export refuses unstable graph content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hg-unstable-')), api = new FakeApi(fixture());
  let reads = 0;
  const wrapped = { async request(method: 'GET' | 'POST', path: string, body?: Row) {
    if (path.endsWith('/schema') && ++reads === 2) api.state.vertices[0].properties.name = 'changed';
    return api.request(method, path, body);
  } };
  try { await assert.rejects(exportGraph(wrapped, '/g', join(root, 'backup'), 'http://localhost'), /changed/); assert.equal(api.writes.length, 0); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('restore maps primary IDs to new native IDs, preserves custom IDs, and repeats with zero writes', async () => {
  const source = fixture(), api = new FakeApi();
  const check = await restore(api, '/g', source, true); assert.equal(check.writes, 0); assert.equal(api.writes.length, 0);
  const result = await restore(api, '/g', source, false); assert.equal(result.success, true);
  assert.notEqual(api.state.vertices.find(v => v.label === 'Agent')!.id, 'old-primary-id');
  assert.equal(api.state.vertices.find(v => v.label === 'Capability')!.id, 'cap:stable');
  assert.equal(api.state.edges[0].inV, api.state.vertices.find(v => v.label === 'Agent')!.id);
  const again = await restore(api, '/g', source, false); assert.equal(again.writes, 0);
  assert.ok(api.writes.every(w => w.method === 'POST'));
});
test('property/Schema conflicts and unrelated target content stop restore before any write', async () => {
  for (const change of ['property', 'schema', 'extra']) {
    const source = fixture(), existing = fixture();
    if (change === 'property') existing.vertices[0].properties.name = 'different';
    if (change === 'schema') existing.schema.propertykeys[0].data_type = 'INT';
    if (change === 'extra') existing.vertices.push({ id: 'extra', label: 'Capability', properties: { name: 'unrelated' } });
    const api = new FakeApi(existing);
    await assert.rejects(restore(api, '/g', source, false), /differs|outside/); assert.equal(api.writes.length, 0);
  }
});
test('interrupted restore can resume with matching objects without duplication', async () => {
  const source = fixture(), partial = empty(); partial.schema = structuredClone(source.schema); partial.vertices = [source.vertices[0]];
  const api = new FakeApi(partial), result = await restore(api, '/g', source, false);
  assert.equal(result.writes, 2); assert.equal(api.state.vertices.length, 2); assert.equal(api.state.edges.length, 1);
});
test('read-only client rejects a write without a network request; unsupported modes fail', async () => {
  const api = new Client('http://127.0.0.1:18080', 'unused', 'unused');
  await assert.rejects(api.request('POST', '/g/graph/vertices', {}), /cannot write/); api.clear();
  const source = fixture(); source.schema.edgelabels[0].frequency = 'MULTIPLE';
  assert.throws(() => preflight(source, empty()), /SINGLE/);
});
test('actual exported backup restores to a simulated empty graph and repeats with zero writes', async () => {
  const file = process.env.SOFTWAREFACTORY_BACKUP_TEST_FILE ?? fileURLToPath(new URL('../data/current/graph-backup.json', import.meta.url));
  const { state } = await readBackup(file);
  const api = new FakeApi(), first = await restore(api, '/g', state, false);
  assert.equal(first.success, true); assert.deepEqual(counts(api.state), counts(state));
  const before = api.writes.length, repeated = await restore(api, '/g', state, false);
  assert.equal(repeated.writes, 0); assert.equal(api.writes.length, before);
  const remapped = await snapshot(api, '/g'), repeat = preflight(state, remapped);
  assert.equal(repeat.missingSchema.length + repeat.missingVertices.length + repeat.missingEdges.length, 0);
});
