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

// MULTI SELECT WITH SELECT ALL / UNSELECT ALL
async function selectWithEnquirerMulti(items, message) {
  const { MultiSelect, Separator } = await import("enquirer");

  const choices = [
    { name: "__select_all", message: "Select All", value: "__select_all" },
    {
      name: "__unselect_all",
      message: "Unselect All",
      value: "__unselect_all",
    },
    new Separator(),
    ...items,
  ];

  const prompt = new MultiSelect({
    name: "choices",
    message,
    hint: "(space to toggle, type to filter)",
    choices,
    result(names) {
      // Strip out meta items
      return names.filter((n) => !n.startsWith("__"));
    },
  });

  // Handle toggle events for select-all / unselect-all
  prompt.on("toggle", (choice) => {
    if (!choice) return;

    if (choice.value === "__select_all") {
      prompt.choices.forEach((c) => {
        if (typeof c.value === "string" && !c.value.startsWith("__")) {
          c.selected = true;
        }
      });
    }

    if (choice.value === "__unselect_all") {
      prompt.choices.forEach((c) => {
        if (typeof c.value === "string" && !c.value.startsWith("__")) {
          c.selected = false;
        }
      });
    }
  });

  const picked = await prompt.run();
  return picked.map((v) => items.indexOf(v));
}

async function confirm(msg) {
  const { Confirm } = await import("enquirer");
  const c = new Confirm({ name: "ok", message: msg });
  return await c.run();
}

// -------------------------------------------------------------
// Main Logic
// -------------------------------------------------------------
export default async function runCLI() {
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
