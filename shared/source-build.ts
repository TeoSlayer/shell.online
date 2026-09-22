// Build just the CLI; Node and a web build are not required for hosted sessions.
export function sourceBuildCommands(version: string, windows = false): string {
  const binary = windows ? "shell.exe" : "shell";
  return [
    `git clone --depth 1 --branch v${version} https://github.com/TeoSlayer/shell.online.git`,
    "cd shell.online",
    `go build -buildvcs=false -trimpath -ldflags="-X main.version=${version}" -o ${binary} ./cmd/shell`,
    `${windows ? ".\\" : "./"}${binary} --version`,
  ].join("\n");
}
