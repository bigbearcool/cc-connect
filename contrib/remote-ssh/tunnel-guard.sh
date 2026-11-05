#!/usr/bin/env sh
# Optional reverse tunnel for contrib/remote-ssh: lets the remote machine reach the network through
# an HTTP proxy on THIS host, so the remote agent works even without its own internet access and
# shares this host's egress IP.
#
#   remote 127.0.0.1:${REMOTE_PORT}  ->  this host 127.0.0.1:${LOCAL_PROXY_PORT}
#
# Usage: SSH_HOST=devbox LOCAL_PROXY_PORT=7890 REMOTE_PORT=17897 ./tunnel-guard.sh
# Run it under systemd / launchd / a terminal multiplexer; it reconnects forever.
set -u
: "${SSH_HOST:?set SSH_HOST}"
: "${LOCAL_PROXY_PORT:?set LOCAL_PROXY_PORT (your local HTTP proxy port)}"
REMOTE_PORT="${REMOTE_PORT:-17897}"

while :; do
  echo "[$(date '+%F %T')] tunnel: connecting ${SSH_HOST} (remote ${REMOTE_PORT} -> local ${LOCAL_PROXY_PORT})"
  ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o ConnectTimeout=10 \
      -R "127.0.0.1:${REMOTE_PORT}:127.0.0.1:${LOCAL_PROXY_PORT}" "${SSH_HOST}"
  echo "[$(date '+%F %T')] tunnel: exited ($?), retry in 10s"
  sleep 10
done
