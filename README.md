# CANNLab EnvPilot

`cannlabctl` is a local TypeScript/Node.js CLI for inspecting and managing CANNLab environments.

The project name is **EnvPilot**: it describes a small, deliberate control plane rather than a second web console.

## Install and run

```bash
npm install
npm run build
node dist/index.js --help
```

For local development, `npm run dev -- overview` is equivalent to `cannlabctl overview`.

## Authentication

For ordinary commands, the CLI uses a shell-provided `CANNLAB_ACCESS_TOKEN` first, then the private cache at `~/.config/cannlab-envpilot/auth.json`, then a token or account/password from `.env`. It never sends a classic GitCode PAT to CANNLab, and it does not use browser cookies or `xauth_token`.

```bash
cannlabctl auth login
cannlabctl auth status
cannlabctl auth logout --yes
```

If GitCode asks for 易盾/MFA, paste the web `access_token` when prompted. The cache is `0600`; the containing directory is `0700`. Existing `.env` files are tightened to `0600` when read.

## Commands

```text
cannlabctl overview
cannlabctl catalog list
cannlabctl env list
cannlabctl env show <instance-key>
cannlabctl env create --type <a2|a3|cpu> --name <name> --template <code-or-name> --spec <code-or-name>
cannlabctl env start <instance-key>
cannlabctl env stop <instance-key>
cannlabctl env delete <instance-key-or-pair-id> [--id-type instance|pair] [--yes]
cannlabctl env upgrade <instance-key> [--version <version>]
cannlabctl env git-ssh-key <instance-key> --out <file>
cannlabctl env git-token <instance-key> --out <file>
```

All commands support `--json`. Lifecycle operations wait by default (5 seconds between checks and 30 minutes maximum); use `--no-wait`, `--interval`, or `--timeout` when appropriate. Destructive deletion always asks for confirmation unless `--yes` is supplied. `/home` and `/mnt/workspace` data may be lost when an environment is deleted.

The create flow reads the current `create-access`, `create-goods`, and `create-config` responses and resolves names or codes at runtime. No image, template, or machine specification is hard-coded.

Here `--type` selects the hardware goods (CPU/A2/A3), `--template` selects an image template, and `--spec` selects that template's resource flavor, such as `16vCPUs 32GiB`. The underlying `goods_code`, `spec_code`, `template_spec_code`, and `image_code` are all discovered from the live response.

Sensitive Git credentials require `--out`. The result is atomically written as JSON with mode `0600`, refuses to overwrite an existing file, and is never printed.

## API boundary

The default API is the internal CANNLab proxy at:

```text
https://web-api.gitcode.com/score-proxy/api/v1/shop/third-party
```

Use `CANNLAB_API_BASE` for a compatible test endpoint. GET requests have bounded retries; create, delete, and lifecycle POST requests are never automatically replayed because a network failure can leave the remote operation ambiguous.

This repository is local-only for now. It does not configure a Git remote or push credentials.

The separate live test is opt-in: set `CANNLAB_RUN_LIVE=1` for read-only checks, and additionally set `CANNLAB_ALLOW_LIVE_MUTATIONS=1` only when the temporary CPU lifecycle test is explicitly authorized.
