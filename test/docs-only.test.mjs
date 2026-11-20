import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideStructuralSkip,
  docsOnlyOutput,
  isDocumentationOnly,
  isMarkdownDocPath,
} from '../lib/docs-only.mjs';
import {
  assertAssertedDocsCovered,
  controlPathMatches,
  joinControlPathAlternatives,
} from '../lib/asserted-doc-paths.mjs';

test('isMarkdownDocPath never treats .github as docs', () => {
  assert.equal(isMarkdownDocPath('docs/guide.md'), true);
  assert.equal(isMarkdownDocPath('README.md'), true);
  assert.equal(isMarkdownDocPath('.github/workflows/ci.yml'), false);
  assert.equal(isMarkdownDocPath('src/app.ts'), false);
});

test('isDocumentationOnly requires a non-empty all-docs path set', () => {
  assert.equal(isDocumentationOnly({ changedPaths: [] }), false);
  assert.equal(
    isDocumentationOnly({ changedPaths: ['docs/a.md', 'README.md'] }),
    true
  );
  assert.equal(
    isDocumentationOnly({ changedPaths: ['docs/a.md', 'src/x.ts'] }),
    false
  );
});

test('decideStructuralSkip is fail-closed except docs_only + no selection', () => {
  assert.equal(
    decideStructuralSkip({
      eventName: 'merge_group',
      docsOnly: true,
      diffBaseUsable: true,
      changedFilesEmpty: false,
      structuralSelected: false,
    }).skip,
    true
  );
  for (const input of [
    {
      eventName: 'merge_group',
      docsOnly: false,
      diffBaseUsable: true,
      changedFilesEmpty: false,
      structuralSelected: false,
    },
    {
      eventName: 'merge_group',
      docsOnly: true,
      diffBaseUsable: false,
      changedFilesEmpty: false,
      structuralSelected: false,
    },
    {
      eventName: 'merge_group',
      docsOnly: true,
      diffBaseUsable: true,
      changedFilesEmpty: true,
      structuralSelected: false,
    },
    {
      eventName: 'merge_group',
      docsOnly: true,
      diffBaseUsable: true,
      changedFilesEmpty: false,
      structuralSelected: true,
    },
    {
      eventName: 'pull_request',
      docsOnly: true,
      diffBaseUsable: true,
      changedFilesEmpty: false,
      structuralSelected: false,
    },
  ]) {
    assert.equal(decideStructuralSkip(input).skip, false, JSON.stringify(input));
  }
  assert.equal(docsOnlyOutput(false), 'docs_only=false');
});

test('asserted-docs ratchet fails closed on uncovered tracked docs', () => {
  const pattern = joinControlPathAlternatives(`
# comment
^docs/covered\\.md$
^README\\.md$
`);
  assert.equal(controlPathMatches(pattern, 'docs/covered.md'), true);
  const covered = assertAssertedDocsCovered({
    assertedPaths: ['docs/covered.md', 'README.md', 'docs/fixture.md'],
    controlPattern: pattern,
    exclusions: ['docs/fixture.md'],
  });
  assert.equal(covered.ok, true);
  const missing = assertAssertedDocsCovered({
    assertedPaths: ['docs/covered.md', 'docs/new.md'],
    controlPattern: pattern,
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['docs/new.md']);
});
