import { execFileSync, spawn } from 'node:child_process';
import readline from 'node:readline';

// -------------------------------------------------------------
// Helper utilities
// -------------------------------------------------------------
function has(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

// -------------------------------------------------------------
// Pure Node confirm (stable)
// -------------------------------------------------------------
async function confirm(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise((resolve) => {
    rl.question(`${message} (y/N) `, (ans) => resolve(ans));
  });

  rl.close();

  const a = answer.trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

// -------------------------------------------------------------
// FZF async selector (non-freezing). Toggle available only when multi=true
// -------------------------------------------------------------
async function selectWithFzf(items, prompt, multi = false) {
  if (!has('fzf')) return null;
  if (!items.length) return [];

  let list = items;
  let hasToggle = false;
  if (multi) {
    hasToggle = true;
    list = ['__SELECT_ALL__', ...items];
  }

  const input = list.map((item, idx) => `${idx}	${item}`).join('\n');

  return new Promise((resolve) => {
    const args = ['--prompt', `${prompt}: `, '--layout=reverse'];
    if (multi) args.push('--multi');

    const proc = spawn('fzf', args, { stdio: ['pipe', 'pipe', 'inherit'] });

    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => (out += chunk));

    proc.on('close', () => {
      if (!out.trim()) return resolve([]);
      const idxs = out
        .trim()
        .split('\n')
        .map((line) => parseInt(line.split('\t')[0], 10));

      if (hasToggle && idxs.includes(0)) {
        // select all (return indices for original items)
        resolve(items.map((_, i) => i));
        return;
      }

      if (hasToggle) {
        resolve(idxs.map((i) => i - 1).filter((i) => i >= 0 && i < items.length));
        return;
      }

      resolve(idxs.filter((i) => i >= 0 && i < items.length));
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

// -------------------------------------------------------------
// Enquirer fallback (with select-all toggle for workflows only)
// -------------------------------------------------------------
async function selectWithEnquirerSingle(items, message) {
  const { AutoComplete } = await import('enquirer');
  const p = new AutoComplete({
    name: 'choice',
    message,
    choices: items,
  });
  const ans = await p.run();
  return items.indexOf(ans);
}

async function selectWithEnquirerMulti(items, message) {
  const { MultiSelect } = await import('enquirer');

  // toggle choice inserted only for workflows (multi-selection)
  const choices = [
    { name: '⏹ SELECT / UNSELECT ALL', value: '__TOGGLE_ALL__' },
    ...items.map((it) => ({ name: it, value: it }))
  ];

  const p = new MultiSelect({
    name: 'workflows',
    message,
    hint: '(space to select, type to filter)',
    choices,
    // disableLoop: true
  });

  // Listen for "toggle" selection by user pressing space on the first item.
  // Enquirer emits 'key' events, but simpler approach: intercept submit result and handle toggle if present.
  p.on('submit', (answer) => {
    // no-op here; we'll process after run
  });

  // Run prompt
  const ans = await p.run(); // ans is array of selected values (strings)

  // If toggle present among selections, interpret as select-all or unselect-all:
  if (ans.includes('__TOGGLE_ALL__')) {
    // If only toggle selected -> treat as select-all
    // Otherwise remove toggle and proceed
    // Determine whether toggle indicates selecting all or none by checking rest
    const rest = ans.filter((v) => v !== '__TOGGLE_ALL__');
    if (rest.length === 0) {
      // user only toggled -> select all
      return items.map((_, i) => i);
    } else {
      // user included toggle + others: treat as those selections (remove toggle)
      return rest.map((v) => items.indexOf(v)).filter((i) => i >= 0);
    }
  }

  // Normal path: map selected values to indices
  return ans.map((v) => items.indexOf(v)).filter((i) => i >= 0);
}

// -------------------------------------------------------------
// Main logic
// -------------------------------------------------------------
export async function main() {
  if (!has('git')) {
    console.error('git not found in PATH');
    process.exit(1);
  }
  if (!has('gh')) {
    console.error('gh (GitHub CLI) not found in PATH');
    process.exit(1);
  }

  // 1) git refs
  const refsRaw = run('git', [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/tags'
  ]);
  const refs = refsRaw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!refs.length) {
    console.log('No git refs found.');
    return;
  }

  // 2) choose ref (fzf single or enquirer)
  let refIdxs = await selectWithFzf(refs, 'Select branch/tag', false);
  let refIdx;
  if (refIdxs === null) {
    refIdx = await selectWithEnquirerSingle(refs, 'Select branch or tag');
  } else {
    if (!refIdxs.length) {
      console.log('No selection.');
      return;
    }
    refIdx = refIdxs[0];
  }
  const selectedRef = refs[refIdx];
  console.log('Selected ref:', selectedRef);

  // 3) list workflows via gh (JSON)
  const raw = run('gh', ['workflow', 'list', '--limit', '500', '--json', 'name,path,state']);
  let data = [];
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse `gh workflow list` output:', e.message || e);
    return;
  }

  const workflows = data
    .filter((w) => w && w.state === 'active')
    .map((w) => `${w.name} — ${w.path}`);

  if (!workflows.length) {
    console.log('No active workflows found.');
    return;
  }

  // 4) select workflows (multi). Toggle present only here.
  let wIdxs = await selectWithFzf(workflows, 'Select workflows to dispatch', true);
  if (wIdxs === null) {
    wIdxs = await selectWithEnquirerMulti(workflows, 'Select workflows to dispatch');
  }
  if (!wIdxs.length) {
    console.log('No workflows selected. Exiting.');
    return;
  }

  const chosen = wIdxs.map((i) => workflows[i]).filter(Boolean);
  console.log('\nWill dispatch the following workflows:');
  chosen.forEach((c) => console.log(' -', c));

  const ok = await confirm('Proceed and dispatch workflows?');
  if (!ok) {
    console.log('Canceled by user.');
    return;
  }

  // 5) dispatch
  for (const c of chosen) {
    const path = c.split(' — ')[1];
    if (!path) continue;
    console.log(`Dispatching ${path} on ref ${selectedRef}`);
    try {
      execFileSync('gh', ['workflow', 'run', path, '--ref', selectedRef], { stdio: 'inherit' });
    } catch (e) {
      console.error('Dispatch failed for', path, e.message || e);
    }
  }

  console.log('All done.');
}
