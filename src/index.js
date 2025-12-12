// src/index.js
import { execFileSync, spawn } from "node:child_process";
import readline from "node:readline";

// -------------------------------------------------------------
// Utilities
// -------------------------------------------------------------
function has(cmd) {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch {
    return "";
  }
}

// -------------------------------------------------------------
// Pure-Node confirm (readline) - bulletproof across envs
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

  const a = (answer || "").trim().toLowerCase();
  return a === "y" || a === "yes";
}

// -------------------------------------------------------------
// FZF async selector (non-freezing) with Ctrl-A toggle for visible items
// -------------------------------------------------------------
async function selectWithFzf(items, prompt, multi = false) {
  if (!has("fzf")) return null;
  if (!items.length) return [];

  // build numbered lines so we can map back to original indices
  const input = items.map((item, idx) => `${idx + 1}\t${item}`).join("\n");

  return new Promise((resolve) => {
    // header explains Ctrl-A behaviour when multi
    const header = multi
      ? "Hint: use Space to select, Ctrl-A to toggle all VISIBLE items (after filtering)."
      : "";

    const args = [
      "--prompt",
      `${prompt}: `,
      "--layout=reverse",
      "--ansi",
      "--header",
      header,
    ];
    if (multi) {
      args.push("--multi");
      // ensure ctrl-a toggles visible entries
      args.push("--bind", "ctrl-a:toggle-all");
    }

    const proc = spawn("fzf", args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });

    let out = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => (out += chunk));

    proc.on("close", () => {
      if (!out.trim()) return resolve([]);
      // parse lines like "  12\tworkflow name"
      const idxs = out
        .trim()
        .split("\n")
        .map((line) => {
          const tok = line.split("\t", 1)[0].trim();
          const n = parseInt(tok, 10);
          return Number.isNaN(n) ? -1 : n - 1;
        })
        .filter((i) => i >= 0 && i < items.length);
      resolve(idxs);
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

// -------------------------------------------------------------
// Enquirer selectors
// -------------------------------------------------------------
async function selectWithEnquirerSingle(items, message) {
  const { AutoComplete } = await import("enquirer");
  const prompt = new AutoComplete({
    name: "choice",
    message,
    choices: items,
    limit: 10,
  });
  const ans = await prompt.run();
  return items.indexOf(ans);
}

/**
 * Enquirer multi-select with visible-toggle:
 * - Loop: ask a filter, show visible items + a Toggle visible option
 * - Toggle affects only the visible (filtered) items
 * - Selections persist across filter changes
 * - Commands at filter step:
 *    :done  -> finish and return indices
 *    :reset -> clear all selections
 */
async function selectWithEnquirerMulti(items, message) {
  const { Input, MultiSelect, Separator } = await import("enquirer");

  // track selected values (strings from items)
  const selectedSet = new Set();

  // helper: show a short summary of current selections
  function summary() {
    if (selectedSet.size === 0) return "(none)";
    const sample = Array.from(selectedSet).slice(0, 6);
    return `${selectedSet.size} selected — ${sample.join(", ")}${selectedSet.size > 6 ? ", ..." : ""}`;
  }

  // Main loop: filter -> pick -> update selectedSet -> repeat until :done
  while (true) {
    const inPrompt = new Input({
      name: "filter",
      message: `${message} — filter (empty = all). Commands: :done (finish), :reset (clear). Current: ${summary()}`,
      initial: "",
    });

    let filter;
    try {
      filter = (await inPrompt.run()).trim();
    } catch {
      // user aborted (Ctrl+C)
      return [];
    }

    if (filter === ":done") {
      // finish and return selected indices
      return Array.from(selectedSet)
        .map((v) => items.indexOf(v))
        .filter((i) => i >= 0);
    }

    if (filter === ":reset") {
      selectedSet.clear();
      continue;
    }

    // compute visible (filtered) items (preserve original ordering & index)
    const q = filter.toLowerCase();
    const visible =
      q === ""
        ? items.map((it, idx) => ({ it, idx }))
        : items
            .map((it, idx) => ({ it, idx }))
            .filter(({ it }) => it.toLowerCase().includes(q));

    if (visible.length === 0) {
      console.log("No items match that filter — try again.");
      continue;
    }

    // Build MultiSelect choices: toggle option, separator, visible items (marked as selected if in selectedSet)
    const choices = [
      {
        name: "__TOGGLE__",
        message: `Toggle visible (${visible.length})`,
        value: "__TOGGLE__",
      },
      new Separator(),
      ...visible.map(({ it }) => ({
        name: it,
        message: it,
        value: it,
        selected: selectedSet.has(it),
      })),
    ];

    const ms = new MultiSelect({
      name: "pick",
      message: `Filtered: ${visible.length} shown — use space to (un)select, enter to submit`,
      hint: "(space to toggle, type to re-filter after submit)",
      choices,
      // keep limit reasonable
      limit: 15,
    });

    let result;
    try {
      result = await ms.run(); // array of selected values (strings)
    } catch {
      // user aborted (Ctrl+C)
      return [];
    }

    // result may contain '__TOGGLE__' and/or a selection of visible items
    if (result.includes("__TOGGLE__")) {
      const rest = result.filter((v) => v !== "__TOGGLE__");
      if (rest.length === 0) {
        // user selected only the toggle -> invert selection on visible items
        const allSelected = visible.every(({ it }) => selectedSet.has(it));
        if (allSelected) {
          // unselect all visible
          for (const { it } of visible) selectedSet.delete(it);
        } else {
          // select all visible
          for (const { it } of visible) selectedSet.add(it);
        }
      } else {
        // user chose toggle + explicit items -> set visible items exactly to explicit selection
        for (const { it } of visible) selectedSet.delete(it);
        for (const v of rest) selectedSet.add(v);
      }
    } else {
      // Normal path: set visible items to match selection
      for (const { it } of visible) selectedSet.delete(it);
      for (const v of result) selectedSet.add(v);
    }

    // Loop back to allow re-filtering and fine-grain edits
  }
}

// -------------------------------------------------------------
// Main Logic
// -------------------------------------------------------------
export default async function main() {
  if (!has("git")) {
    console.error("git not found");
    process.exit(1);
  }
  if (!has("gh")) {
    console.error("gh not found");
    process.exit(1);
  }

  // 1. Get refs
  const refs = run("git", [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/tags",
  ])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!refs.length) {
    console.log("No refs found.");
    return;
  }

  // 2. Select ref (fzf single or enquirer fallback)
  let refIdxs = await selectWithFzf(refs, "Select branch/tag", false);
  let refIdx;
  if (refIdxs === null) {
    refIdx = await selectWithEnquirerSingle(refs, "Select branch or tag");
  } else {
    if (!refIdxs.length) {
      console.log("No selection.");
      return;
    }
    refIdx = refIdxs[0];
  }

  const selectedRef = refs[refIdx];
  console.log("Selected ref:", selectedRef);

  // 3. Fetch workflows
  const raw = run("gh", [
    "workflow",
    "list",
    "--limit",
    "500",
    "--json",
    "name,path,state",
  ]);

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error("Invalid workflow JSON:", e && e.message ? e.message : e);
    return;
  }

  const workflows = data
    .filter((w) => w && w.state === "active")
    .map((w) => `${w.name} — ${w.path}`);

  if (!workflows.length) {
    console.log("No active workflows.");
    return;
  }

  // 4. Select workflows (multi)
  let wIdxs = await selectWithFzf(workflows, "Select workflows", true);
  if (wIdxs === null) {
    wIdxs = await selectWithEnquirerMulti(
      workflows,
      "Select workflows to dispatch",
    );
  }

  if (!wIdxs.length) {
    console.log("Nothing selected.");
    return;
  }

  const chosen = wIdxs.map((i) => workflows[i]);

  // Show summary
  console.log("\nWill dispatch:");
  for (const w of chosen) console.log(" -", w);

  const ok = await confirm("Proceed?");
  if (!ok) {
    console.log("Cancelled.");
    return;
  }

  // 5. Dispatch workflow runs
  for (const w of chosen) {
    const path = w.split(" — ")[1];
    console.log(`Dispatching ${path} on ${selectedRef}`);

    try {
      execFileSync("gh", ["workflow", "run", path, "--ref", selectedRef], {
        stdio: "inherit",
      });
    } catch (e) {
      console.error("Failed:", e.message);
    }
  }

  console.log("Done.");
}
