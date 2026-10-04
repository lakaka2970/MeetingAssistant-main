# Shared Chromium-sandbox preflight for every script that launches Electron.
#
# npm unpacks node_modules/electron/dist/chrome-sandbox as the installing user
# with mode 755, and Ubuntu 22.10+ blocks unprivileged user namespaces for
# unconfined processes. When both are true Electron aborts before any of our
# code runs:
#   FATAL:setuid_sandbox_host.cc:166] The SUID sandbox helper binary was found,
#   but is not configured correctly ...
# which reads as "this script is broken" to whoever runs it. So probe both and
# pass --no-sandbox only when neither sandbox is actually available.
#
# Usage:
#   . tools/sandbox-preflight.sh
#   mc_detect_sandbox                      # sets MC_SANDBOX_ARGS / MC_SANDBOX_STATE
#   npx electron . "${MC_SANDBOX_ARGS[@]}"
#
# MC_SANDBOX_STATE: suid | userns | fallback
MC_SANDBOX_ARGS=()
MC_SANDBOX_STATE=userns
MC_SANDBOX_HELPER=node_modules/electron/dist/chrome-sandbox

function mc_detect_sandbox() {
  MC_SANDBOX_ARGS=()
  MC_SANDBOX_STATE=userns
  [[ "$(uname -s)" == 'Linux' ]] || return 0
  local ready=0
  [[ "$(stat -c '%U' "$MC_SANDBOX_HELPER" 2>/dev/null)" == 'root' ]] &&
    [[ "$(stat -c '%a' "$MC_SANDBOX_HELPER" 2>/dev/null)" == '4755' ]] && ready=1
  if [[ $ready -eq 1 ]]; then
    MC_SANDBOX_STATE=suid
  elif ! unshare -Ur true 2>/dev/null; then
    MC_SANDBOX_STATE=fallback
    MC_SANDBOX_ARGS=(--no-sandbox)
  fi
  return 0
}
