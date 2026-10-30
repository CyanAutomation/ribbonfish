import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSkills } from '../validate-skills.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('repository skills have valid metadata, sibling references, and local links', async () => {
  assert.deepEqual(await validateSkills(path.join(repositoryRoot, '.github/skills')), []);
});

test('reports missing metadata, mismatched names, unknown related skills, and broken links', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ribbonfish-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'example'), { recursive: true });
  await writeFile(path.join(root, 'example/SKILL.md'), [
    '---',
    'name: wrong-name',
    'description: Example skill',
    'tags: [demo]',
    'relatedSkills: [missing-skill]',
    '---',
    '',
    '[Broken](../absent.md)',
  ].join('\n'));

  assert.deepEqual(await validateSkills(root), [
    'example/SKILL.md: name "wrong-name" must match directory "example"',
    'example/SKILL.md: related skill "missing-skill" does not exist',
    'example/SKILL.md: local link "../absent.md" does not exist',
  ]);
});

test('reports missing required frontmatter fields', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ribbonfish-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'example'), { recursive: true });
  await writeFile(path.join(root, 'example/SKILL.md'), '---\nname: example\n---\n');

  assert.deepEqual(await validateSkills(root), [
    'example/SKILL.md: missing required frontmatter field "description"',
    'example/SKILL.md: missing required frontmatter field "tags"',
    'example/SKILL.md: missing required frontmatter field "relatedSkills"',
  ]);
});

test('checks each local link with a single filesystem stat', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ribbonfish-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'example'), { recursive: true });
  await writeFile(path.join(root, 'example/SKILL.md'), [
    '---',
    'name: example',
    'description: Example skill',
    'tags: [demo]',
    'relatedSkills: []',
    '---',
    '',
    '[Reference](../reference.md)',
  ].join('\n'));
  await writeFile(path.join(root, 'reference.md'), 'Reference');

  const target = path.join(root, 'reference.md');
  let statCalls = 0;
  const errors = await validateSkills(root, {
    statFn: async (filename) => {
      if (filename === target) statCalls += 1;
      return stat(filename);
    },
  });

  assert.deepEqual(errors, []);
  assert.equal(statCalls, 1);
});
