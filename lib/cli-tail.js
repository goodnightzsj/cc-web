// R57: read-only tail of a Claude CLI JSONL file written by an externally-running
// `claude` process (the one the user is using in their terminal, not the
// subprocess cc-web spawns). Replays each newly-appended event through the
// existing processClaudeEvent pipeline so the browser sees text_delta /
// thinking_delta / tool_use / tool_result / system_message exactly as if the
// chat were happening inside cc-web.
//
// Design choices:
// - polling fs.stat every 500ms (NOT fs.watch): file rotation + truncation
//   handling is simpler, ext4 + macOS APFS reliable, ~2 syscalls/s overhead.
// - per-ws single tail at a time (calling startTail again stops the previous).
// - read-only: caller is responsible for disabling user input in the UI.
// - the pseudo-entry never gets activeProcesses.set(), so abort / send_message
//   commands are inert on this session — the external CLI owns writes.

const fs = require('fs');

const POLL_MS = 500;

function createTail({ jsonlPath, onEvent, onError, onClose }) {
  let offset = 0;
  let lineBuf = '';
  let stopped = false;
  let inFlight = false;
  let pollTimer = null;

  function readFromOffset() {
    if (stopped || inFlight) return;
    inFlight = true;
    fs.stat(jsonlPath, (err, stat) => {
      if (stopped) { inFlight = false; return; }
      if (err) {
        inFlight = false;
        // File rotated or missing — keep polling rather than tearing down,
        // user might just have created a new turn.
        if (err.code !== 'ENOENT') onError?.(err);
        return;
      }
      if (stat.size < offset) {
        // truncated/rotated — restart from 0
        offset = 0;
        lineBuf = '';
      }
      if (stat.size <= offset) { inFlight = false; return; }

      const stream = fs.createReadStream(jsonlPath, {
        start: offset,
        end: stat.size - 1,
        encoding: 'utf8',
      });
      let acc = '';
      stream.on('data', (chunk) => { acc += chunk; });
      stream.on('error', (e) => { inFlight = false; onError?.(e); });
      stream.on('end', () => {
        offset = stat.size;
        const combined = lineBuf + acc;
        const lines = combined.split('\n');
        lineBuf = lines.pop() || '';  // last partial line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            try { onEvent(event); } catch (e) { onError?.(e); }
          } catch {
            // skip malformed lines silently — CLI sometimes writes partial
            // lines during high-throughput moments.
          }
        }
        inFlight = false;
      });
    });
  }

  pollTimer = setInterval(readFromOffset, POLL_MS);
  // Initial read kicks immediately so user sees current state without waiting.
  setImmediate(readFromOffset);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      onClose?.();
    },
    isRunning() { return !stopped; },
  };
}

module.exports = { createTail };
