#!/usr/bin/env bash
# Moves Concord's GitHub repository (and optionally others) into a GitHub organisation,
# so CI runs on that organisation's own Actions minutes. See docs/moving-accounts.md.
#
#   scripts/move-to-org.sh <org> [owner/repo ...]            dry run: checks and shows the plan
#   scripts/move-to-org.sh <org> [owner/repo ...] --apply    does it, asking before each change
#   ... --apply --yes                                        does it without asking
#
# Create the organisation first, in the browser (GitHub has no API for that):
#   https://github.com/account/organizations/new?plan=free
#
# Options:
#   --apply           make changes (default is a dry run that changes nothing)
#   --yes             with --apply, don't ask before each step
#   --reset-secrets   ask for every Actions secret again, not only the ones missing after
#                     the transfer
#   --no-pr           don't open the PR that repoints the repo's own links
#   --no-check        don't start a CI run to prove Actions works in the organisation
#
# Works with macOS's bash 3.2. Needs: gh (signed in as an admin of the repos and an owner of the organisation), git,
# node. Optional: the vercel CLI, in a folder linked to the Concord project.
#
# Secret values are typed at a hidden prompt and piped straight to `gh secret set`; they
# are never echoed, logged, written to disk or passed on a command line.
set -euo pipefail

ORG=''
REPOS=()
APPLY=0
YES=0
RESET_SECRETS=0
OPEN_PR=1
CHECK=1
MAIN_REPO='jeswr/standards-concord'

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --yes) YES=1 ;;
    --reset-secrets) RESET_SECRETS=1 ;;
    --no-pr) OPEN_PR=0 ;;
    --no-check) CHECK=0 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option $arg" >&2; exit 2 ;;
    *) if [ -z "$ORG" ]; then ORG="$arg"; else REPOS+=("$arg"); fi ;;
  esac
done
[ -n "$ORG" ] || { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ "$ORG" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]] || { echo "\"$ORG\" isn't a GitHub organisation name." >&2; exit 2; }
[ ${#REPOS[@]} -gt 0 ] || REPOS=("$MAIN_REPO")

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$*"; }
fail() { printf '  \033[31mx %s\033[0m\n' "$*" >&2; exit 1; }
ok() { printf '  \033[32mok\033[0m %s\n' "$*"; }

# step "description" -> 0 to go ahead, 1 to skip. In a dry run, always skip (and say so).
step() {
  if [ "$APPLY" -ne 1 ]; then
    info "[dry run] would: $1"
    return 1
  fi
  if [ "$YES" -eq 1 ]; then
    info "-> $1"
    return 0
  fi
  local answer
  read -r -p "  $1? [y/N] " answer </dev/tty
  [[ "$answer" =~ ^[Yy] ]]
}

if [ "$APPLY" -ne 1 ]; then
  bold "Dry run: nothing will change. Re-run with --apply to do it."
fi

# --- Preflight ---------------------------------------------------------------------
bold "Checking access"
command -v gh >/dev/null || fail "gh is not installed (https://cli.github.com)."
command -v git >/dev/null || fail "git is not installed."
gh auth status >/dev/null 2>&1 || fail "gh is not signed in. Run: gh auth login"
ME=$(gh api user --jq .login)
ok "signed in to GitHub as $ME"

ORG_OK=1
if ! gh api "orgs/$ORG" >/dev/null 2>&1; then
  ORG_OK=0
  warn "organisation $ORG doesn't exist yet (or you can't see it). Create it first:"
  warn "https://github.com/account/organizations/new?plan=free"
  [ "$APPLY" -eq 1 ] && exit 1
else
  role=$(gh api "user/memberships/orgs/$ORG" --jq .role 2>/dev/null || echo none)
  [ "$role" = admin ] || fail "you are '$role' in $ORG; transferring into it needs an owner (admin)."
  ok "you own the organisation $ORG"
fi

for repo in "${REPOS[@]}"; do
  name=${repo#*/}
  if gh api "repos/$ORG/$name" >/dev/null 2>&1 && ! gh api "repos/$repo" --jq .full_name 2>/dev/null | grep -qx "$repo"; then
    ok "$repo is already at $ORG/$name"
    continue
  fi
  perm=$(gh api "repos/$repo" --jq .permissions.admin 2>/dev/null || echo false)
  [ "$perm" = true ] || fail "you aren't an admin of $repo (or it doesn't exist)."
  ok "you administer $repo"
done

# --- Per repository ----------------------------------------------------------------
for repo in "${REPOS[@]}"; do
  name=${repo#*/}
  new="$ORG/$name"
  bold "$repo -> $new"

  already=0
  if [ "$ORG_OK" -eq 1 ] && [ "$(gh api "repos/$new" --jq .full_name 2>/dev/null || true)" = "$new" ]; then
    already=1
  fi

  # Note the secret and variable names before the move, to check them afterwards.
  src=$repo; [ "$already" -eq 1 ] && src=$new
  secret_names=$(gh secret list -R "$src" --json name --jq '.[].name' 2>/dev/null || true)
  variables=$(gh variable list -R "$src" --json name,value --jq '.[] | [.name, .value] | @tsv' 2>/dev/null || true)
  info "Actions secrets: $(tr '\n' ' ' <<<"${secret_names:-none}")"
  info "Actions variables: $(cut -f1 <<<"${variables:-none}" | tr '\n' ' ')"

  # 1. Transfer. GitHub keeps issues, PRs, stars, webhooks, secrets and deploy keys, and
  #    redirects the old web, git and API addresses to the new one.
  if [ "$already" -eq 1 ]; then
    ok "already transferred"
  elif step "transfer $repo to $ORG (hard to undo: only an owner of $ORG can transfer it back)"; then
    gh api -X POST "repos/$repo/transfer" -f new_owner="$ORG" >/dev/null
    for _ in $(seq 1 30); do
      [ "$(gh api "repos/$new" --jq .full_name 2>/dev/null || true)" = "$new" ] && break
      sleep 2
    done
    [ "$(gh api "repos/$new" --jq .full_name 2>/dev/null || true)" = "$new" ] || fail "$new didn't appear after a minute; check https://github.com/$new"
    ok "transferred"
    already=1
  fi

  # 2. Actions must be allowed in the organisation and on the repo.
  if [ "$already" -eq 1 ]; then
    org_enabled=$(gh api "orgs/$ORG/actions/permissions" --jq .enabled_repositories 2>/dev/null || echo unknown)
    if [ "$org_enabled" = none ]; then
      step "allow GitHub Actions for all repositories in $ORG" && gh api -X PUT "orgs/$ORG/actions/permissions" -f enabled_repositories=all -f allowed_actions=all >/dev/null && ok "Actions allowed in $ORG"
    fi
    repo_enabled=$(gh api "repos/$new/actions/permissions" --jq .enabled 2>/dev/null || echo unknown)
    if [ "$repo_enabled" = false ]; then
      step "turn on GitHub Actions for $new" && gh api -X PUT "repos/$new/actions/permissions" -F enabled=true -f allowed_actions=all >/dev/null && ok "Actions on for $new"
    elif [ "$repo_enabled" = true ]; then
      ok "Actions is on for $new"
    fi
  else
    info "[dry run] would: check Actions is allowed in $ORG and on $new"
  fi

  # 3. Secrets: re-enter any that didn't come across (or all, with --reset-secrets).
  if [ "$already" -eq 1 ]; then
    have=$(gh secret list -R "$new" --json name --jq '.[].name' 2>/dev/null || true)
    for s in $secret_names; do
      if [ "$RESET_SECRETS" -eq 0 ] && grep -qx "$s" <<<"$have"; then
        ok "secret $s is set"
        continue
      fi
      if step "set the Actions secret $s on $new (you'll type it at a hidden prompt)"; then
        IFS= read -r -s -p "  Value for $s (hidden, Enter to skip): " value </dev/tty; echo
        if [ -n "$value" ]; then
          printf '%s' "$value" | gh secret set "$s" -R "$new" >/dev/null && ok "secret $s set"
        else
          warn "skipped $s"
        fi
        unset value
      fi
    done
    # Variables aren't secret, so they're copied as they were.
    have_vars=$(gh variable list -R "$new" --json name --jq '.[].name' 2>/dev/null || true)
    while IFS=$'\t' read -r vname vvalue; do
      [ -n "$vname" ] || continue
      grep -qx "$vname" <<<"$have_vars" && { ok "variable $vname is set"; continue; }
      step "set the Actions variable $vname on $new" && gh variable set "$vname" -R "$new" --body "$vvalue" >/dev/null && ok "variable $vname set"
    done <<<"$variables"
  else
    info "[dry run] would: check the secrets $(tr '\n' ' ' <<<"${secret_names:-(none)}")arrived, and ask at a hidden prompt for any that didn't"
  fi
done

# --- This checkout ------------------------------------------------------------------
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
NEW_MAIN="$ORG/${MAIN_REPO#*/}"
is_main_checkout=0
if [ -n "$ROOT" ] && [ -f "$ROOT/scripts/move-repo.mjs" ]; then
  url=$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)
  case "$url" in *"${MAIN_REPO}"*|*"${NEW_MAIN}"*) is_main_checkout=1 ;; esac
fi
moving_main=0
for repo in "${REPOS[@]}"; do [ "$repo" = "$MAIN_REPO" ] && moving_main=1; done

if [ "$moving_main" -eq 1 ] && [ "$is_main_checkout" -eq 1 ]; then
  bold "This checkout ($ROOT)"
  url=$(git -C "$ROOT" remote get-url origin)
  if [[ "$url" == *"$MAIN_REPO"* ]]; then
    newurl=${url/$MAIN_REPO/$NEW_MAIN}
    step "point origin at $newurl" && git -C "$ROOT" remote set-url origin "$newurl" && ok "origin is $newurl"
  else
    ok "origin already points at $NEW_MAIN"
  fi

  # 4. A PR that repoints the repo's own links: plugin and marketplace listings, the
  #    Connect page's install commands, the container image and the MCP Registry name.
  if [ "$OPEN_PR" -eq 1 ]; then
    branch="move-to-$ORG"
    if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
      warn "this checkout has uncommitted changes, so the repoint PR is left for later:"
      warn "commit or stash, then: node scripts/move-repo.mjs $ORG, commit, push and open a PR"
    elif step "create branch $branch, run node scripts/move-repo.mjs $ORG, push it and open a PR on $NEW_MAIN"; then
      git -C "$ROOT" switch -c "$branch"
      (cd "$ROOT" && node scripts/move-repo.mjs "$ORG")
      (cd "$ROOT" && node scripts/move-repo.mjs --check)
      git -C "$ROOT" commit -qam "Point links at $NEW_MAIN after the move to $ORG"
      git -C "$ROOT" push -u origin "$branch"
      gh pr create -R "$NEW_MAIN" --base main --head "$branch" \
        --title "Point links at $NEW_MAIN" \
        --body "Generated by scripts/move-to-org.sh after transferring the repository to $ORG: \`node scripts/move-repo.mjs $ORG\` updates the plugin and marketplace listings, the Connect page install commands, the container image in the deploy scripts and the MCP Registry name (io.github.$ORG/concord). Opened ready for review, so its CI run also proves Actions works in $ORG."
      ok "PR opened"
    fi
  fi
elif [ "$moving_main" -eq 1 ]; then
  warn "run this from a checkout of $MAIN_REPO that has scripts/move-repo.mjs to update origin and open the repoint PR"
fi

# --- Vercel ---------------------------------------------------------------------------
if [ "$moving_main" -eq 1 ]; then
  bold "Vercel"
  info "Vercel needs its GitHub app installed on $ORG before it can see the repo:"
  info "https://github.com/apps/vercel/installations/select_target"
  if command -v vercel >/dev/null && [ -n "$ROOT" ] && [ -f "$ROOT/.vercel/project.json" ]; then
    step "reconnect the linked Vercel project to https://github.com/$NEW_MAIN (vercel git connect)" \
      && (cd "$ROOT" && vercel git connect "https://github.com/$NEW_MAIN") && ok "Vercel project connected to $NEW_MAIN"
  else
    info "No linked vercel CLI here. In the Vercel project: Settings -> Git -> Disconnect, then Connect Git Repository -> $NEW_MAIN."
    info "(Or: npm i -g vercel; vercel link; then re-run this script.)"
  fi
fi

# --- Prove Actions runs -------------------------------------------------------------
if [ "$CHECK" -eq 1 ] && [ "$moving_main" -eq 1 ]; then
  bold "Checking Actions runs in $ORG"
  if step "start a CI run on main of $NEW_MAIN and wait until its first job is really running"; then
    before=$(gh run list -R "$NEW_MAIN" -w ci.yml -L 1 --json databaseId --jq '.[0].databaseId // 0' 2>/dev/null || echo 0)
    gh workflow run ci.yml -R "$NEW_MAIN" --ref main
    id=$before
    for _ in $(seq 1 30); do
      id=$(gh run list -R "$NEW_MAIN" -w ci.yml -L 1 --json databaseId --jq '.[0].databaseId // 0')
      [ "$id" != "$before" ] && break
      sleep 4
    done
    [ "$id" != "$before" ] || fail "no new CI run appeared; look at https://github.com/$NEW_MAIN/actions"
    verdict=''
    for _ in $(seq 1 90); do
      # "<status> <conclusion> <steps finished>" for the first job
      line=$(gh run view "$id" -R "$NEW_MAIN" --json jobs --jq '[.jobs[0] | .status, (.conclusion // "-"), ([.steps[]? | select(.status=="completed")] | length)] | map(tostring) | join(" ")' 2>/dev/null || true)
      read -r jstatus jconclusion jsteps <<<"${line:-queued - 0}"
      if [ "$jstatus" = completed ] && [ "${jsteps:-0}" -le 1 ] && [ "$jconclusion" != success ]; then verdict=refused; break; fi
      if [ "${jsteps:-0}" -ge 3 ]; then verdict=running; break; fi
      sleep 5
    done
    case "$verdict" in
      running) ok "Actions is running jobs in $ORG. Follow the rest: https://github.com/$NEW_MAIN/actions/runs/$id" ;;
      refused) fail "the job stopped before running any step, which is how GitHub refuses jobs for billing. Check https://github.com/organizations/$ORG/settings/billing" ;;
      *) warn "the run hasn't started a job after several minutes (queued?). Watch https://github.com/$NEW_MAIN/actions/runs/$id" ;;
    esac
  fi
fi

# --- What's left (browser only) ----------------------------------------------------
bold "Left to do in the browser"
info "1. Give Claude access: https://github.com/apps/claude/installations/select_target -> $ORG"
info "2. In the Claude project: Project settings -> Repositories, swap $MAIN_REPO for $NEW_MAIN"
info "3. Merge the repoint PR once its CI is green"
info "4. Only while the Azure backend is still in use: after the first main build, make"
info "   https://github.com/orgs/$ORG/packages/container/package/standards-concord public, and set"
info "   IMAGE=ghcr.io/$(tr '[:upper:]' '[:lower:]' <<<"$ORG")/standards-concord:latest in /opt/concord/stack.env on the VM"
info "5. Update anything outside the repo that names $MAIN_REPO (routines, other clones)"
[ "$APPLY" -eq 1 ] || bold "That was a dry run. Re-run with --apply to make the changes, one confirmation at a time."
