#!/bin/sh
# Launches the Claude Code binary as the unprivileged agent user.
# The bot (root) sets CLAUDE_REAL_BIN and AGENT_USER in the environment it passes.
set -e
: "${CLAUDE_REAL_BIN:?CLAUDE_REAL_BIN not set}"
: "${AGENT_USER:?AGENT_USER not set}"
exec setpriv --reuid="$AGENT_USER" --regid="$AGENT_USER" --init-groups --inh-caps=-all -- "$CLAUDE_REAL_BIN" "$@"
