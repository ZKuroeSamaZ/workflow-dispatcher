# workflow-dispatcher

Private CLI for dispatching GitHub Actions workflows.

This repo is prepared to be published under your GitHub account **ZKuroeSamaZ**.
The package name is **@ZKuroeSamaZ/workflow-dispatcher** and the repo URL in package.json
is set to your GitHub: https://github.com/ZKuroeSamaZ/workflow-dispatcher

## Quick install (via git)

On machines that have SSH access to your private repo:

```bash
# install locally
npm install git+ssh://git@github.com:ZKuroeSamaZ/workflow-dispatcher.git

# or install globally
npm install -g git+ssh://git@github.com:ZKuroeSamaZ/workflow-dispatcher.git

# run
workflow-dispatcher
```

If you prefer to publish it to GitHub Packages or npm private registry, follow the usual publish steps.

## Notes

- Requires `git` and `gh` on PATH.
- Optional: `fzf` for fuzzy search UX. If absent, the CLI falls back to `enquirer`.
- The multi-select workflow picker includes a **Select / Unselect All** toggle as the first item.

