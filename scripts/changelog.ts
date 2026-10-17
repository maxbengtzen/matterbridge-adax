/**
 * Maintains CHANGELOG.md. Changes are collected under "## Unreleased" until a release.
 *
 *   node scripts/changelog.ts check            fail if "## Unreleased" is missing or empty (preversion hook)
 *   node scripts/changelog.ts release [ver]    turn "## Unreleased" into "## <ver> — <date>" and start a new empty
 *                                              Unreleased section (version hook; ver defaults to npm_package_version)
 *   node scripts/changelog.ts notes <ver>      print the section for <ver>, for the GitHub release
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../CHANGELOG.md', import.meta.url);
const UNRELEASED = '## Unreleased';

function fail(message: string): never {
  console.error(`changelog: ${message}`);
  process.exit(1);
}

/** The text of the section whose heading starts with `heading`, up to the next "## " heading. */
function section(text: string, heading: string): string | null {
  const start = text.search(new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm'));
  if (start < 0) return null;
  const bodyStart = text.indexOf('\n', start) + 1;
  const next = text.indexOf('\n## ', bodyStart);
  return text.slice(bodyStart, next < 0 ? undefined : next + 1).trim();
}

const [command, arg] = process.argv.slice(2);
const text = readFileSync(FILE, 'utf8');

if (command === 'check' || command === 'release') {
  const body = section(text, UNRELEASED);
  if (body === null) fail(`no "${UNRELEASED}" heading`);
  if (!body) fail('Unreleased is empty: describe the changes before releasing');
  if (command === 'release') {
    const version = arg ?? process.env.npm_package_version ?? fail('no version given');
    if (section(text, `## ${version}`) !== null) fail(`${version} is already in CHANGELOG.md`);
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(FILE, text.replace(UNRELEASED, `${UNRELEASED}\n\n## ${version} — ${date}`));
    console.log(`changelog: Unreleased → ${version} (${date})`);
  }
} else if (command === 'notes') {
  if (!arg) fail('usage: notes <version>');
  const body = section(text, `## ${arg.replace(/^v/, '')}`);
  if (!body) fail(`no section for ${arg} in CHANGELOG.md`);
  console.log(body);
} else {
  fail('usage: changelog.ts check | release [version] | notes <version>');
}
