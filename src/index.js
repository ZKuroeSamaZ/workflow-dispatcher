// src/index.js
import { execFileSync, spawn } from "node:child_process";
import readline from "node:readline";
import Enquirer from "enquirer";
const { AutoComplete, MultiSelect, Separator, Confirm, Input } = Enquirer;

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
// Pure-Node confirm (readline) fallback
// -------------------------------------------------------------
async function readlineConfirm(message) {
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

  const input = items.map((item, idx) => `${idx + 1}\t${item}`).join("\n");

  return new Promise((resolve) => {
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
// Enquirer selectors (v3+ compatible)
// -------------------------------------------------------------
export async function selectWithEnquirerSingle(items, message) {
  const answer = await AutoComplete({
    name: "choice",
    message,
    choices: items,
    limit: 10,
  })();
  return items.indexOf(answer);
}

export async function selectWithEnquirerMulti(items, message) {
  const selectedSet = new Set();

  function summary() {
    if (selectedSet.size === 0) return "(none)";
    const sample = Array.from(selectedSet).slice(0, 6);
    return `${selectedSet.size} selected — ${sample.join(", ")}${selectedSet.size > 6 ? ", ..." : ""}`;
  }

  while (true) {
    const filter = (
      await Input({
        name: "filter",
        message: `${message} — filter (empty = all). Commands: :done (finish), :reset (clear). Current: ${summary()}`,
        initial: "",
      })()
    ).trim();

    if (filter === ":done") {
      return Array.from(selectedSet)
        .map((v) => items.indexOf(v))
        .filter((i) => i >= 0);
    }
    if (filter === ":reset") {
      selectedSet.clear();
      continue;
    }

    const q = filter.toLowerCase();
    const visible =
      q === ""
        ? items.map((it, idx) => ({ it, idx }))
        : items
            .map((it, idx) => ({ it, idx }))
            .filter(({ it }) => it.toLowerCase().includes(q));

    if (!visible.length) {
      console.log("No items match that filter — try again.");
      continue;
    }

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

    let result = await MultiSelect({
      name: "pick",
      message: `Filtered: ${visible.length} shown — use space to (un)select, enter to submit`,
      hint: "(space to toggle, type to re-filter after submit)",
      choices,
      limit: 15,
    })();

    if (result.includes("__TOGGLE__")) {
      const rest = result.filter((v) => v !== "__TOGGLE__");
      if (!rest.length) {
        const allSelected = visible.every(({ it }) => selectedSet.has(it));
        if (allSelected) visible.forEach(({ it }) => selectedSet.delete(it));
        else visible.forEach(({ it }) => selectedSet.add(it));
      } else {
        visible.forEach(({ it }) => selectedSet.delete(it));
        rest.forEach((v) => selectedSet.add(v));
      }
    } else {
      visible.forEach(({ it }) => selectedSet.delete(it));
      result.forEach((v) => selectedSet.add(v));
    }
  }
}

export async function confirm(message) {
  try {
    return await EnquirerConfirm({ name: "ok", message })();
  } catch {
    return await readlineConfirm(message);
  }
}

// -------------------------------------------------------------
// Main logic
// -------------------------------------------------------------
export async function main() {
  if (!has("git")) {
    console.error("git not found");
    process.exit(1);
  }
  if (!has("gh")) {
    console.error("gh not found");
    process.exit(1);
  }

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

  let refIdxs = await selectWithFzf(refs, "Select branch/tag", false);
  let refIdx =
    refIdxs === null
      ? await selectWithEnquirerSingle(refs, "Select branch or tag")
      : refIdxs[0];
  const selectedRef = refs[refIdx];
  console.log("Selected ref:", selectedRef);

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
    console.error("Invalid workflow JSON:", e.message);
    return;
  }

  const workflows = data
    .filter((w) => w.state === "active")
    .map((w) => `${w.name} — ${w.path}`);
  if (!workflows.length) {
    console.log("No active workflows.");
    return;
  }

  let wIdxs = await selectWithFzf(workflows, "Select workflows", true);
  if (wIdxs === null)
    wIdxs = await selectWithEnquirerMulti(
      workflows,
      "Select workflows to dispatch",
    );
  if (!wIdxs.length) {
    console.log("Nothing selected.");
    return;
  }

  const chosen = wIdxs.map((i) => workflows[i]);
  console.log("\nWill dispatch:");
  for (const w of chosen) console.log(" -", w);

  const ok = await confirm("Proceed?");
  if (!ok) {
    console.log("Cancelled.");
    return;
  }

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
