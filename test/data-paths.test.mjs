import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPr } from '../guards/plugins/data-paths.mjs';
const p = { data: [/^data\//], append: [/^events\.jsonl$/], label: 'data-exception' };
test('data additions fail while data-only removal is permitted', () => {
 assert.equal(checkPr([{filename:'data/x.json',status:'added'}],p).length,1);
 assert.deepEqual(checkPr([{filename:'data/x.json',status:'removed'}],p),[]);
});
test('append-only additions fail while deletion is permitted', () => {
 assert.equal(checkPr([{filename:'events.jsonl',status:'modified',deletions:0}],p).length,1);
 assert.deepEqual(checkPr([{filename:'events.jsonl',status:'removed',deletions:1}],p),[]);
});
