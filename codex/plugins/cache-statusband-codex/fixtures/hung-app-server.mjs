import { writeFileSync } from "node:fs";

// An app-server that accepts input and never answers: a hung Codex.
// The pid is recorded synchronously, as the very first statement, so a test can tell a server
// that started from one that was killed or never launched.
if (process.env.HUNG_PID_FILE) writeFileSync(process.env.HUNG_PID_FILE, String(process.pid));
process.stdin.resume();
// It ends itself after 30 s, longer than any test waits for it, so no test has to kill it by pid:
// once the code under test has stopped it, its pid may be reused by an unrelated process.
setTimeout(() => process.exit(0), 30_000);
