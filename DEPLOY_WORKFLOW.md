# Deploy Workflow — Git is the single source of truth for CODE

(IBKR is the source of truth for NUMBERS; git/GitHub is the source of truth for CODE.)

## The rule
**Never scp / patch code onto the server.** That caused live⇄repo drift (the deployed
V4.5 was never committed, so every agent/repo saw a different codebase). Code ships ONLY
through git.

## Normal flow (every change, every agent)
1. Edit on a feature branch, locally or on the server checkout.
2. `git add <files>` → `git commit -m "..."` → `git push origin <branch>`.
3. On the server: `/root/deploy-tradesnow.sh [branch]`
   - refuses to run if there are uncommitted tracked changes (forces discipline),
   - `git pull --ff-only`, installs deps only if the lockfile changed,
   - `corepack pnpm build`, `pm2 restart tradesnow-app`, `pm2 save`.

## Remote
`origin = git@github.com:y0505300530-pixel/tradesnow.git`

## One-time baseline (REQUIRED before the script will deploy)
The server currently has uncommitted deployed work. Commit + push it once so the working
tree matches a pushed commit:
```
cd /root/tradesnow
git add -A                      # secrets are gitignored; junk now gitignored too
git commit -m "baseline: capture live V4.5 deployed state"
git push origin feat/elza-v5-bloodhound-shelf
```
After that, all future changes go commit → push → deploy-tradesnow.sh.

## Secrets
`.env`, `secrets/` are gitignored and NEVER committed. They live only on the server.
