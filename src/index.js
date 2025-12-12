// src/index.js
import { execFileSync, spawn } from "node:child_process";

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
// FZF async selector (non-freezing)
// -------------------------------------------------------------
async function selectWithFzf(items, prompt, multi = false) {
  if (!has("fzf")) return null;
  if (!items.length) return [];

  const input = items.map((item, idx) => `${idx + 1}\t${item}`).join("\n");

  return new Promise((resolve) => {
    const args = ["--prompt", `${prompt}: `, "--layout=reverse"];
    if (multi) args.push("--multi");

    const proc = spawn("fzf", args, {
      stdio: ["pipe", "pipe", "inherit"],
    });

    let out = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => (out += chunk));

    proc.on("close", () => {
      if (!out.trim()) return resolve([]);
      const idxs = out
        .trim()
        .split("\n")
        .map((line) => parseInt(line.split("\t")[0], 10) - 1)
        .filter((i) => i >= 0 && i < items.length);
      resolve(idxs);
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

// -------------------------------------------------------------
// Enquirer Selectors
// -------------------------------------------------------------
async function selectWithEnquirerSingle(items, message) {
  const { AutoComplete } = await import("enquirer");
  const prompt = new AutoComplete({
    name: "choice",
    message,
    choices: items,
  });
  const ans = await prompt.run();
  return items.indexOf(ans);
}

// Replace your existing selectWithEnquirerMulti with this function.
// It uses a loop: ask for a filter, present MultiSelect of filtered items
// (with a Toggle visible option), update global selection state, repeat
// until user confirms they're done.
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

  while (true) {
    // 1) Ask user for a filter string (empty => all). Special commands:
    //    :done -> finish selection
    //    :reset -> clear all selections
    const inPrompt = new Input({
      name: "filter",
      message: `${message} — filter (empty = all). Commands: :done (finish), :reset (clear). Current: ${summary()}`,
      initial: "",
    });

    let filter;
    try {
      filter = (await inPrompt.run()).trim();
    } catch {
      // user aborted input (Ctrl+C)
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
      // go back to filter prompt loop
      continue;
    }

    // compute visible (filtered) items
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

    // Build MultiSelect choices: first the toggle option, then visible items
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
        // mark as selected if present in the global selectedSet
        selected: selectedSet.has(it),
      })),
    ];

    const ms = new MultiSelect({
      name: "pick",
      message: `Filtered: ${visible.length} shown — use space to (un)select, enter to submit`,
      hint: "(space to toggle, type to re-filter after submit)",
      choices,
    });

    let result;
    try {
      result = await ms.run(); // array of selected values (strings)
    } catch {
      // user aborted (Ctrl+C)
      return [];
    }

    // result contains the selected values from the visible subset (and possibly __TOGGLE__)
    // Handle toggle semantics:
    if (result.includes("__TOGGLE__")) {
      // If user selected only the toggle -> we interpret as "invert selection of visible"
      const rest = result.filter((v) => v !== "__TOGGLE__");
      if (rest.length === 0) {
        // decide: if ALL visible currently selected -> unselect them; else select them
        const allSelected = visible.every(({ it }) => selectedSet.has(it));
        if (allSelected) {
          // unselect all visible
          for (const { it } of visible) selectedSet.delete(it);
        } else {
          // select all visible
          for (const { it } of visible) selectedSet.add(it);
        }
      } else {
        // toggle + some explicit selections -> treat explicit selections as chosen (remove toggle)
        // update selectedSet: ensure visible items are set exactly to rest
        // first remove all visible items from selectedSet
        for (const { it } of visible) selectedSet.delete(it);
        // then add rest
        for (const v of rest) selectedSet.add(v);
      }
    } else {
      // No toggle in result: update visible items to match selection
      // remove all visible from selectedSet, then add those returned
      for (const { it } of visible) selectedSet.delete(it);
      for (const v of result) selectedSet.add(v);
    }

    // loop again: user can re-filter, check summary, etc.
    // Optionally we could ask "done?" here, but the filter prompt supports :done
    // and the loop shows the current summary so user knows status.
  }
}

async function confirm(msg) {
  const { Confirm } = await import("enquirer");
  const c = new Confirm({ name: "ok", message: msg });
  return await c.run();
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

  // 2. Select ref
  let refIdxs = await selectWithFzf(refs, "Select branch/tag", false);
  let refIdx =
    refIdxs === null
      ? await selectWithEnquirerSingle(refs, "Select branch or tag")
      : refIdxs[0];

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
  } catch {
    console.error("Invalid workflow JSON.");
    return;
  }

  const workflows = data
    .filter((w) => w.state === "active")
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
