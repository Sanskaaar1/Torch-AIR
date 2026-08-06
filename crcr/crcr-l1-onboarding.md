# CRCR Level 1 Onboarding — RHEL + PyTorch Accelerator Backends

This guide helps **accelerator backend** teams attain **CRCR Level 1 (Onboarding)** so their downstream repository receives PyTorch upstream events and can run CI against **PyTorch `main`** on **RHEL**.
At L1, the relay **dispatches** `repository_dispatch` events to your repo. Results are **not** reported back to the PyTorch HUD (that starts at L2).
| Level | Name | What you get |
|-------|------|--------------|
| **L1** | Onboarding | Receive dispatches; no upstream feedback |
| L2 | Observation | + HUD reporting |
| L3 | Stable | + label-gated non-blocking PR checks |
| L4 | Mature | + blocking checks (reserved) |
---
## Prerequisites
Before starting, confirm all of the following:
1. **Public downstream repository** with **GitHub Actions enabled**  
   - Repo visibility: **Public**  
   - Settings → Actions → General → Actions permissions allow workflows to run  
2. **CI builds and tests against PyTorch `main`**  
   - On each dispatch, check out `pytorch/pytorch` at the **dispatched commit SHA** (PR head SHA or push `after` SHA)  
   - Do **not** pin an old release tag or a vendor fork tip as the upstream source of truth for CRCR PR/push events
---
## Goal of Level 1
After completing these steps, when a PR is opened/updated (or a relevant push occurs) on `pytorch/pytorch`:
1. CRCR sends a `repository_dispatch` to your repo  
2. Your workflow starts  
3. You check out PyTorch at the dispatched SHA and run your RHEL build/test  
4. You **do not** need HUD callbacks yet (L2+)
---
## Step 1 — Join the `#crcr` Slack channel
Join the PyTorch **`#crcr`** channel (PyTorch Dev Infra / community Slack).
Use the channel to:
- Ask for allowlist / GitHub App installation approval  
- Confirm dispatches are flowing  
---
## Step 2 — Request allowlist addition (L1)
Open a PR against [`pytorch/pytorch`](https://github.com/pytorch/pytorch) that adds your repository under **`L1`** in:
[`.github/allowlist.yml`](https://github.com/pytorch/pytorch/blob/main/.github/allowlist.yml#L39)
Example:
```yaml
L1:
  - riseproject-dev/pytorch-ci
  - NVIDIA-dev/pytorch-oot-internal
  - NVIDIA/pytorch-windows-ci
  - google-pytorch/torch_tpu
  - your-org/your-accelerator-ci   # ← add your public repo here
```
**PR tips:**
- Use `org/repo` exactly as it appears on GitHub  
- Start at **L1** even if you plan L2 later  
- In the PR description, note: public repo, RHEL+PyTorch CI, workflow checks out PyTorch at the dispatched SHA  
Wait until the allowlist PR is **merged** before expecting live dispatches.
---
## Step 3 — Install the CRCR GitHub App on the downstream repo
Install the **[pytorch-fdn-cross-repo-ci-relay](https://github.com/apps/pytorch-fdn-cross-repo-ci-relay)** GitHub App on your downstream repository.
1. Open the App page → **Configure**  
2. Select the org/account that owns the downstream repo  
3. Grant access to **only** the CI repository that should receive dispatches  
4. If installation needs approval, request it in `#crcr` 
Without the App installed on your repo, allowlist entry alone is not enough for reliable dispatch delivery.
---
## Step 4 — Add the dispatch receiver workflow
Follow the official integration steps:
**[CI Integration → Integration Steps](https://docs.pytorch.org/docs/2.13/accelerator/ci.html#integration-steps)**
### RHEL + PyTorch expectations for L1
| Requirement | Guidance |
|-------------|----------|
| Upstream source | Always `pytorch/pytorch` at the **relay SHA** (PR head / push `after`) |
| OS under test | [RHEL 9.x](https://github.com/TorchedHat/pytorch-redhat-ci/blob/main/docker/Dockerfile.rhel9) (or UBI-based container matching your support matrix) |
| Secrets | Keep RHEL subscription / registry credentials in GitHub Actions secrets; never bake into image layers |
| Job scope at L1 | Smoke or short build+import is enough to prove the pipe; expand later |
| Callbacks | **Not required** for L1 (no `cross-repo-ci-relay-callback`, no `id-token: write` unless you are preparing for L2) |
For a fuller RHEL container build pattern, use [TorchedHat/pytorch-redhat-ci](https://github.com/TorchedHat/pytorch-redhat-ci) as a reference (nightly/PR workflows, podman, subscription secrets).
