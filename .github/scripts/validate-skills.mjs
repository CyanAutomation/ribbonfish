import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requiredFields = ['name', 'description', 'tags', 'relatedSkills'];

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/);
    if (field) fields.set(field[1], field[2]);
  }
  return fields;
}

function parseInlineList(value) {
  const match = value?.match(/^\[([\s\S]*)\]$/);
  if (!match) return null;
  if (!match[1].trim()) return [];
  return match[1].split(',').map((item) => item.trim()).filter(Boolean)
    .map((item) => item.replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted));
}

export async function validateSkills(skillsRoot) {
  const errors = [];
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skills = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const skillNames = new Set(skills);

  for (const directory of skills) {
    const relativeFile = `${directory}/SKILL.md`;
    const file = path.join(skillsRoot, directory, 'SKILL.md');
    let markdown;
    try {
      markdown = await readFile(file, 'utf8');
    } catch {
      errors.push(`${relativeFile}: missing SKILL.md`);
      continue;
    }

    const fields = parseFrontmatter(markdown);
    if (!fields) {
      errors.push(`${relativeFile}: missing YAML frontmatter`);
      continue;
    }
    for (const field of requiredFields) {
      if (!fields.get(field)) errors.push(`${relativeFile}: missing required frontmatter field "${field}"`);
    }
    if (fields.has('name') && fields.get('name') !== directory) {
      errors.push(`${relativeFile}: name "${fields.get('name')}" must match directory "${directory}"`);
    }

    const tags = parseInlineList(fields.get('tags'));
    if (fields.has('tags') && (!tags || tags.length === 0)) {
      errors.push(`${relativeFile}: tags must be a non-empty inline list`);
    }
    const relatedSkills = parseInlineList(fields.get('relatedSkills'));
    if (fields.has('relatedSkills') && !relatedSkills) {
      errors.push(`${relativeFile}: relatedSkills must be an inline list`);
    }
    for (const related of relatedSkills ?? []) {
      if (!skillNames.has(related)) errors.push(`${relativeFile}: related skill "${related}" does not exist`);
    }

    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const destination = match[1].trim().split(/\s+/, 1)[0];
      if (!destination || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(destination)) continue;
      const target = path.resolve(path.dirname(file), decodeURIComponent(destination.split('#')[0]));
      try {
        if (!(await stat(target)).isFile() && !(await stat(target)).isDirectory()) {
          errors.push(`${relativeFile}: local link "${destination}" does not exist`);
        }
      } catch {
        errors.push(`${relativeFile}: local link "${destination}" does not exist`);
      }
    }
  }
  return errors;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const skillsRoot = path.resolve(process.argv[2] ?? path.join(path.dirname(scriptPath), '../skills'));
  const errors = await validateSkills(skillsRoot);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Validated skill metadata and links in ${skillsRoot}`);
  }
}
