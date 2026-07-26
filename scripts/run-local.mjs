import { spawn } from "node:child_process";

const mode = process.argv[2] === "start" ? "start" : "dev";
const children = [
  spawn("npm", ["run", mode === "dev" ? "dev:server" : "start:server"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn("npm", ["run", mode === "dev" ? "dev:ui" : "start:ui"], {
    stdio: "inherit",
    env: process.env,
  }),
];

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!stopping && code !== 0) {
      stop();
      process.exitCode = code ?? (signal ? 1 : 0);
    }
  });
}
